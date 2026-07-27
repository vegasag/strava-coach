import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import {
  getAuthorizeUrl,
  exchangeCodeForToken,
  listActivities,
  getActivityDetail,
} from './strava.js';
import {
  getTokensByTenant,
  getRecentActivities,
  getLatestActivities,
  saveActivity,
  saveActivityDetail,
  getActivitiesWithoutDetail,
  getLatestActivityDate,
  createTenant,
  getTenantById,
  getTenantBySlug,
  listTenants,
  setTenantAthleteId,
  countActivities,
  deleteTenant,
  type Tenant,
} from './db.js';
import { analyzeActivityZones } from './analysis.js';

type Env = { Variables: { tenant: Tenant } };
export const app = new Hono<Env>();

// Slugs som ikke kan brukes som tenant (kolliderer med ruter/statiske filer).
const RESERVED = new Set([
  'api', 'auth', 'admin', 'assets', 'favicon.ico', 'robots.txt',
]);

const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-secret';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 år
const PROD = process.env.NODE_ENV === 'production';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Signerte cookies: verdi.hmac(verdi). Ingen server-side sesjonslager nødvendig.
function signValue(value: string): string {
  const sig = createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
  return `${value}.${sig}`;
}
function verifySigned(signed: string | undefined, expected: string): boolean {
  if (!signed) return false;
  const i = signed.lastIndexOf('.');
  if (i < 0) return false;
  const value = signed.slice(0, i);
  return value === expected && safeEqual(signed, signValue(expected));
}

function setAuthCookie(c: any, name: string, value: string) {
  setCookie(c, name, signValue(value), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: PROD,
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';

function isAdmin(c: any): boolean {
  return verifySigned(getCookie(c, 'admin'), 'admin');
}

// Enkel brute-force-brems på admin-login: teller feilforsøk per IP og
// låser i økende intervaller. Nullstilles ved vellykket innlogging.
const loginAttempts = new Map<string, { fails: number; blockedUntil: number }>();

function clientIp(c: any): string {
  return (
    c.req.header('fly-client-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ??
    'local'
  );
}

// Fri de 3 første forsøkene, deretter 5s, 10s, 20s … opp til 5 min.
function blockedSeconds(ip: string): number {
  const rec = loginAttempts.get(ip);
  if (!rec) return 0;
  const left = rec.blockedUntil - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

function registerFail(ip: string) {
  const rec = loginAttempts.get(ip) ?? { fails: 0, blockedUntil: 0 };
  rec.fails++;
  if (rec.fails > 3) {
    const delay = Math.min(5000 * 2 ** (rec.fails - 4), 5 * 60 * 1000);
    rec.blockedUntil = Date.now() + delay;
  }
  loginAttempts.set(ip, rec);
}


// Delt sync-logikk for både tenant-endepunkt og admin-trigget sync.
async function runSync(
  tenant: Tenant,
  opts: {
    deep?: boolean;
    years?: number;
    detailsOnly?: boolean;
    maxActivities?: number;
    maxDetails?: number;
  },
) {
  const deep = opts.deep ?? false;
  const detailsOnly = opts.detailsOnly ?? false;
  let total = 0;

  if (!detailsOnly) {
    let after: number;
    if (deep) {
      const years = opts.years ?? 5;
      after = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 365 * years;
    } else {
      const latest = getLatestActivityDate(tenant.id);
      after = latest
        ? Math.floor(new Date(latest).getTime() / 1000)
        : Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 90;
    }
    let page = 1;
    const maxPages = deep ? 100 : 20;
    while (true) {
      let batch: any[];
      try {
        batch = await listActivities(tenant, { after, page, per_page: 50 });
      } catch {
        break; // rate limited
      }
      if (batch.length === 0) break;
      for (const a of batch) saveActivity(tenant.id, tenant.athlete_id!, a);
      total += batch.length;
      if (batch.length < 50) break;
      if (opts.maxActivities && total >= opts.maxActivities) break;
      page++;
      if (page > maxPages) break;
    }
  }

  const needDetail = getActivitiesWithoutDetail(tenant.id);
  let details = 0;
  let errors = 0;
  for (const actId of needDetail) {
    if (opts.maxDetails && details >= opts.maxDetails) break;
    try {
      const detail = await getActivityDetail(tenant, actId);
      saveActivityDetail(actId, detail);
      details++;
      if (deep && details % 2 === 0) await new Promise((r) => setTimeout(r, 1000));
    } catch {
      errors++;
      if (deep && errors > 3) break;
    }
  }

  return {
    synced: total,
    details_fetched: details,
    detail_errors: errors,
    remaining: needDetail.length - details,
  };
}

// ============================================================
// Admin (global) — beskyttet av ADMIN_PASSWORD (åpen hvis ikke satt, f.eks. dev)
// ============================================================

app.post('/admin/api/login', async (c) => {
  const ip = clientIp(c);
  const wait = blockedSeconds(ip);
  if (wait > 0) {
    return c.json({ error: `for mange forsøk – vent ${wait} sek`, retry_after: wait }, 429);
  }
  const { password } = await c.req.json().catch(() => ({}));
  if (ADMIN_PASSWORD && (!password || !safeEqual(String(password), ADMIN_PASSWORD))) {
    registerFail(ip);
    return c.json({ error: 'feil passord' }, 401);
  }
  loginAttempts.delete(ip);
  setAuthCookie(c, 'admin', 'admin');
  return c.json({ ok: true });
});

app.use('/admin/api/*', async (c, next) => {
  if (c.req.path === '/admin/api/login') return next();
  if (ADMIN_PASSWORD && !isAdmin(c)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

app.get('/admin/api/tenants', (c) => {
  const tenants = listTenants().map((t) => ({
    id: t.id,
    slug: t.slug,
    display_name: t.display_name,
    max_hr: t.max_hr,
    athlete_id: t.athlete_id,
    connected: !!getTokensByTenant(t.id),
    activity_count: countActivities(t.id),
    last_activity: getLatestActivityDate(t.id) ?? null,
    has_own_creds: !!t.strava_client_id,
  }));
  return c.json({ tenants });
});

app.post('/admin/api/tenants', async (c) => {
  const body = await c.req.json();
  const { slug, display_name, max_hr, strava_client_id, strava_client_secret } = body;

  if (!/^[a-z][a-z0-9-]{1,30}$/.test(slug ?? '')) {
    return c.json({ error: 'ugyldig slug (a-z, tall, bindestrek)' }, 400);
  }
  if (RESERVED.has(slug)) return c.json({ error: 'reservert slug' }, 400);
  if (getTenantBySlug(slug)) return c.json({ error: 'slug finnes allerede' }, 409);
  if (!display_name || !Number.isInteger(max_hr)) {
    return c.json({ error: 'mangler display_name eller max_hr' }, 400);
  }

  const t = createTenant({
    slug,
    display_name,
    max_hr,
    strava_client_id: strava_client_id || null,
    strava_client_secret: strava_client_secret || null,
  });
  return c.json({ tenant: t });
});

app.delete('/admin/api/tenants/:id', (c) => {
  const id = Number(c.req.param('id'));
  if (!getTenantById(id)) return c.json({ error: 'unknown tenant' }, 404);
  deleteTenant(id);
  return c.json({ ok: true });
});

app.post('/admin/api/tenants/:id/sync', async (c) => {
  const t = getTenantById(Number(c.req.param('id')));
  if (!t) return c.json({ error: 'unknown tenant' }, 404);
  if (!getTokensByTenant(t.id)) return c.json({ error: 'not connected' }, 401);
  return c.json(await runSync(t, { deep: false }));
});

// ============================================================
// Strava OAuth — start per tenant, callback global (state = slug:nonce)
// ============================================================

app.get('/auth/strava/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state') ?? '';
  if (!code) return c.text('Missing code', 400);
  const slug = state.split(':')[0];
  const tenant = getTenantBySlug(slug);
  if (!tenant) return c.text('Ukjent tenant i state', 400);
  try {
    const tokens = await exchangeCodeForToken(code, tenant);
    setTenantAthleteId(tenant.id, tokens.athlete_id);
    return c.redirect(`/${tenant.slug}?connected=1`);
  } catch (e: any) {
    return c.text(`Auth failed: ${e.message}`, 500);
  }
});

app.get('/:slug/auth/strava', (c) => {
  const tenant = getTenantBySlug(c.req.param('slug'));
  if (!tenant) return c.text('Ukjent tenant', 404);
  const state = `${tenant.slug}:${randomBytes(8).toString('hex')}`;
  return c.redirect(getAuthorizeUrl(tenant, state));
});

// ============================================================
// Tenant-API — /:slug/api/* (tenant resolves via middleware)
// ============================================================

app.use('/:slug/api/*', async (c, next) => {
  const slug = c.req.param('slug');
  if (RESERVED.has(slug)) return c.json({ error: 'unknown tenant' }, 404);
  const tenant = getTenantBySlug(slug);
  if (!tenant) return c.json({ error: 'unknown tenant' }, 404);
  c.set('tenant', tenant);
  await next();
});

app.get('/:slug/api/status', (c) => {
  const tenant = c.get('tenant');
  return c.json({
    connected: !!getTokensByTenant(tenant.id),
    display_name: tenant.display_name,
    slug: tenant.slug,
    max_hr: tenant.max_hr,
    activity_count: countActivities(tenant.id),
  });
});

// Engangsimport av historikk. Henter opptil 500 økter (sammendrag) og et
// begrenset antall detaljer – resten hentes gradvis av vanlig sync.
app.post('/:slug/api/import', async (c) => {
  const tenant = c.get('tenant');
  if (!getTokensByTenant(tenant.id)) return c.json({ error: 'not connected' }, 401);
  const r = await runSync(tenant, {
    deep: true,
    years: 10,
    maxActivities: 500,
    maxDetails: 60,
  });
  return c.json({ ...r, activity_count: countActivities(tenant.id) });
});

app.post('/:slug/api/sync', async (c) => {
  const tenant = c.get('tenant');
  if (!getTokensByTenant(tenant.id)) return c.json({ error: 'not connected' }, 401);
  const r = await runSync(tenant, { deep: false });
  return c.json({ synced: r.synced, details_fetched: r.details_fetched });
});

app.post('/:slug/api/sync/deep', async (c) => {
  const tenant = c.get('tenant');
  if (!getTokensByTenant(tenant.id)) return c.json({ error: 'not connected' }, 401);
  const years = Number(c.req.query('years') ?? 5);
  const detailsOnly = c.req.query('details_only') === '1';
  return c.json(await runSync(tenant, { deep: true, years, detailsOnly }));
});

app.get('/:slug/api/activities', (c) => {
  const tenant = c.get('tenant');
  const weeks = Number(c.req.query('weeks') ?? 8);
  const since = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString();
  const acts = getRecentActivities(tenant.id, since);
  return c.json({
    activities: acts.map((a) => ({
      id: a.id,
      date: a.start_date,
      type: a.type,
      name: a.name,
      distance_km: a.distance / 1000,
      moving_time_s: a.moving_time,
      avg_hr: a.average_heartrate,
      max_hr: a.max_heartrate,
      avg_pace_s_per_km: a.average_speed > 0 ? 1000 / a.average_speed : null,
    })),
  });
});

app.get('/:slug/api/export/claude', (c) => {
  const tenant = c.get('tenant');
  const count = Math.min(Math.max(Number(c.req.query('count') ?? 5), 1), 10);
  const acts = getLatestActivities(tenant.id, count);
  const text = formatActivitiesForExport(acts, tenant);
  return c.json({ text, count: acts.length, max_hr: tenant.max_hr });
});

// ============================================================
// Formatering av eksport-tekst
// ============================================================

function exportHeader(tenant: Tenant): string {
  const m = tenant.max_hr;
  const b70 = Math.round(0.70 * m);
  const b80 = Math.round(0.80 * m);
  const b87 = Math.round(0.87 * m);
  return [
    `Løper: ${tenant.display_name}. Makspuls: ${m}.`,
    `Soner (Bakken-modellen, % av makspuls):`,
    `  Rolig <70% (<${b70}) | Grå 70–80% (${b70}–${b80}, unngås) | Terskel 80–87% (${b80}–${b87}) | Over >87% (>${b87})`,
    '',
  ].join('\n');
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

const WEEKDAYS = [
  'søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag',
];

const WORKOUT_TYPES: Record<number, string> = {
  0: 'standard', 1: 'løp (konkurranse)', 2: 'langtur',
  3: 'intervall/fartlek', 10: 'standard', 11: 'tempo', 12: 'terskel',
};

const ZONE_ORDER: { key: 'easy' | 'gray' | 'threshold' | 'above'; label: string }[] = [
  { key: 'easy', label: 'Rolig' },
  { key: 'gray', label: 'Grå' },
  { key: 'threshold', label: 'Terskel' },
  { key: 'above', label: 'Over' },
];

function formatActivitiesForExport(acts: any[], tenant: Tenant): string {
  if (acts.length === 0) {
    return 'Ingen økter funnet. Synk fra Strava først.';
  }

  const blocks: string[] = [];
  blocks.push(exportHeader(tenant));
  blocks.push(`Treningsøkter (siste ${acts.length}, nyeste først):`);

  acts.forEach((a, i) => {
    const raw = a.raw_json ? JSON.parse(a.raw_json) : {};
    const detail = a.detail_json ? JSON.parse(a.detail_json) : null;

    const localStr: string = raw.start_date_local || a.start_date;
    const datePart = localStr.slice(0, 10);
    const timePart = localStr.slice(11, 16);
    const weekday = WEEKDAYS[new Date(datePart + 'T00:00:00').getDay()] ?? '';

    const km = (a.distance / 1000).toFixed(2);
    const dur = formatDuration(a.moving_time);
    const pace = a.average_speed > 0 ? formatPace(1000 / a.average_speed) : '–';
    const avgHr = a.average_heartrate ? `${Math.round(a.average_heartrate)} bpm` : '–';
    const maxHr = a.max_heartrate ? `${Math.round(a.max_heartrate)} bpm` : '–';

    const lines: string[] = [];
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(`Økt ${i + 1}`);
    lines.push(`Dato: ${datePart} (${weekday})`);
    lines.push(`Klokkeslett: ${timePart}`);
    lines.push(`Tittel: ${a.name ?? '(uten navn)'}`);
    lines.push(`Type: ${a.type}`);

    const desc = detail?.description?.trim();
    lines.push(`Beskrivelse: ${desc ? desc : '(ingen)'}`);

    lines.push(`Distanse: ${km} km | Totaltid: ${dur} | Snittfart: ${pace}`);
    lines.push(`Snittpuls: ${avgHr} | Makspuls: ${maxHr}`);

    const meta: string[] = [];
    if (detail?.perceived_exertion) meta.push(`RPE: ${detail.perceived_exertion}/10`);
    if (detail?.average_cadence) meta.push(`Kadens: ${Math.round(detail.average_cadence * 2)} spm`);
    if (a.total_elevation_gain > 0) meta.push(`Høydemeter: +${Math.round(a.total_elevation_gain)} m`);
    if (detail?.workout_type != null && detail.workout_type !== 0) {
      const wt = WORKOUT_TYPES[detail.workout_type];
      if (wt) meta.push(`Økttype: ${wt}`);
    }
    if (meta.length > 0) lines.push(meta.join(' | '));

    if (detail?.laps && detail.laps.length > 1) {
      lines.push('');
      lines.push(`Runder (${detail.laps.length}):`);
      for (const lap of detail.laps) {
        const lapKm = (lap.distance / 1000).toFixed(2);
        const lapDur = formatDuration(lap.moving_time);
        const lapPace = lap.average_speed > 0 ? formatPace(1000 / lap.average_speed) : '–';
        const lapHr = lap.average_heartrate ? `${Math.round(lap.average_heartrate)} bpm` : '–';
        const lapMax = lap.max_heartrate ? ` (maks ${Math.round(lap.max_heartrate)})` : '';
        lines.push(
          `  ${lap.lap_index}: ${lapKm} km — ${lapDur} — ${lapPace} — ${lapHr}${lapMax}`,
        );
      }
    }

    const zones = analyzeActivityZones(a, tenant.max_hr);
    const totalZoneMin = zones.easy + zones.gray + zones.threshold + zones.above;
    lines.push('');
    if (totalZoneMin > 0) {
      lines.push('Tid i soner:');
      for (const { key, label } of ZONE_ORDER) {
        const min = zones[key];
        if (min <= 0) continue;
        const pct = Math.round((min / totalZoneMin) * 100);
        lines.push(`  ${label}: ${Math.round(min)} min (${pct}%)`);
      }
    } else {
      lines.push('Tid i soner: (ingen pulsdata)');
    }

    blocks.push(lines.join('\n'));
  });

  return blocks.join('\n');
}

function formatPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
}
