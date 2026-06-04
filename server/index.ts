import { Hono } from 'hono';
import { z } from 'zod';
import {
  getAuthorizeUrl,
  exchangeCodeForToken,
  listActivities,
  getActivityDetail,
} from './strava.js';
import {
  getTokens,
  getRecentActivities,
  getLatestActivities,
  saveActivity,
  saveActivityDetail,
  getActivitiesWithoutDetail,
  getLatestActivityDate,
} from './db.js';
import { chat, type ChatMessage } from './claude.js';
import {
  loadProfile,
  addToProfile,
  removeFromProfile,
  setTrainingPhilosophy,
  formatProfileForLLM,
  isValidSection,
} from './profile.js';
import {
  getMonthlyZoneAnalysis,
  analyzeActivityZones,
  DEFAULT_MAX_HR,
} from './analysis.js';

export const app = new Hono();

// --- Strava OAuth ---

app.get('/auth/strava', (c) => {
  return c.redirect(getAuthorizeUrl());
});

app.get('/auth/strava/callback', async (c) => {
  const code = c.req.query('code');
  if (!code) return c.text('Missing code', 400);
  try {
    await exchangeCodeForToken(code);
    // Send brukeren tilbake til frontend
    return c.redirect('/?connected=1');
  } catch (e: any) {
    return c.text(`Auth failed: ${e.message}`, 500);
  }
});

// --- Status ---

app.get('/api/status', (c) => {
  const tokens = getTokens();
  return c.json({ connected: !!tokens, athlete_id: tokens?.athlete_id ?? null });
});

// --- Activities: sync + list ---

app.post('/api/sync', async (c) => {
  const tokens = getTokens();
  if (!tokens) return c.json({ error: 'not connected' }, 401);

  // Inkrementell sync: hent kun nyere enn det vi har
  const latest = getLatestActivityDate(tokens.athlete_id);
  const after = latest
    ? Math.floor(new Date(latest).getTime() / 1000)
    : Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 90; // siste 90 dager

  let page = 1;
  let total = 0;
  while (true) {
    const batch = await listActivities({ after, page, per_page: 50 });
    if (batch.length === 0) break;
    for (const a of batch) saveActivity(tokens.athlete_id, a);
    total += batch.length;
    if (batch.length < 50) break;
    page++;
    if (page > 20) break; // safety
  }

  // Fetch detailed data (laps, splits, RPE) for activities missing it
  const needDetail = getActivitiesWithoutDetail(tokens.athlete_id);
  let details = 0;
  for (const actId of needDetail) {
    try {
      const detail = await getActivityDetail(actId);
      saveActivityDetail(actId, detail);
      details++;
    } catch {
      // Strava rate limit or deleted activity – skip, retry next sync
    }
  }

  return c.json({ synced: total, details_fetched: details });
});

app.post('/api/sync/deep', async (c) => {
  const tokens = getTokens();
  if (!tokens) return c.json({ error: 'not connected' }, 401);

  const years = Number(new URL(c.req.url).searchParams.get('years') ?? 5);
  const detailsOnly = c.req.query('details_only') === '1';
  const after = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 365 * years;

  let total = 0;
  if (!detailsOnly) {
    let page = 1;
    while (true) {
      try {
        const batch = await listActivities({ after, page, per_page: 50 });
        if (batch.length === 0) break;
        for (const a of batch) saveActivity(tokens.athlete_id, a);
        total += batch.length;
        if (batch.length < 50) break;
        page++;
        if (page > 100) break;
      } catch {
        break; // rate limited during summary fetch
      }
    }
  }

  // Fetch details — with pacing to stay within rate limits
  const needDetail = getActivitiesWithoutDetail(tokens.athlete_id);
  let details = 0;
  let errors = 0;
  for (const actId of needDetail) {
    try {
      const detail = await getActivityDetail(actId);
      saveActivityDetail(actId, detail);
      details++;
      if (details % 2 === 0) await new Promise((r) => setTimeout(r, 1000));
    } catch {
      errors++;
      if (errors > 3) break;
    }
  }

  return c.json({
    synced: total,
    details_fetched: details,
    detail_errors: errors,
    remaining: needDetail.length - details,
  });
});

// --- Zone analysis ---

app.get('/api/analysis/zones', (c) => {
  const maxHR = Number(c.req.query('max_hr') ?? 200);
  const data = getMonthlyZoneAnalysis(maxHR);
  return c.json({ max_hr: maxHR, months: data });
});

// --- Claude-eksport: formaterte øktdetaljer klar for copy-paste ---

app.get('/api/export/claude', (c) => {
  const tokens = getTokens();
  if (!tokens) return c.json({ error: 'not connected' }, 401);

  const count = Math.min(Math.max(Number(c.req.query('count') ?? 5), 1), 10);
  const maxHR = Number(c.req.query('max_hr') ?? DEFAULT_MAX_HR);
  const acts = getLatestActivities(tokens.athlete_id, count);

  const text = formatActivitiesForExport(acts, maxHR);
  return c.json({ text, count: acts.length, max_hr: maxHR });
});

app.get('/api/activities', (c) => {
  const tokens = getTokens();
  if (!tokens) return c.json({ error: 'not connected' }, 401);
  const weeks = Number(c.req.query('weeks') ?? 8);
  const since = new Date(
    Date.now() - weeks * 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const acts = getRecentActivities(tokens.athlete_id, since);
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
      avg_pace_s_per_km:
        a.average_speed > 0 ? 1000 / a.average_speed : null,
    })),
  });
});

// --- Brukerprofil ---

app.get('/api/profile', (c) => {
  return c.json(loadProfile());
});

app.post('/api/profile', async (c) => {
  const body = await c.req.json();
  const { section, content } = body;
  if (!section || !content) return c.json({ error: 'missing section or content' }, 400);
  if (!isValidSection(section)) return c.json({ error: `invalid section: ${section}` }, 400);
  const result = addToProfile(section, content);
  return c.json({ result, profile: loadProfile() });
});

app.delete('/api/profile', async (c) => {
  const body = await c.req.json();
  const { section, index } = body;
  if (!section || index == null) return c.json({ error: 'missing section or index' }, 400);
  if (!isValidSection(section)) return c.json({ error: `invalid section: ${section}` }, 400);
  const result = removeFromProfile(section, index);
  return c.json({ result, profile: loadProfile() });
});

app.put('/api/profile/philosophy', async (c) => {
  const body = await c.req.json();
  const { text } = body;
  if (!text || typeof text !== 'string') return c.json({ error: 'missing text' }, 400);
  const result = setTrainingPhilosophy(text);
  return c.json({ result });
});

// --- Chat med Claude ---

const ChatBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      }),
    )
    .min(1),
  weeks_context: z.number().int().min(0).max(52).optional(),
});

app.post('/api/chat', async (c) => {
  const body = await c.req.json();
  const parsed = ChatBody.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

  const { messages, weeks_context = 8 } = parsed.data;

  // Bygg treningskontekst fra DB
  let trainingContext: string | undefined;
  const tokens = getTokens();
  if (tokens && weeks_context > 0) {
    const since = new Date(
      Date.now() - weeks_context * 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const acts = getRecentActivities(tokens.athlete_id, since);
    trainingContext = formatActivitiesForLLM(acts, weeks_context);
  }

  // Inkluder brukerprofil
  const profileContext = formatProfileForLLM();

  try {
    const result = await chat({
      messages: messages as ChatMessage[],
      trainingContext,
      profileContext: profileContext || undefined,
    });
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

function formatActivitiesForLLM(acts: any[], weeks: number): string {
  if (acts.length === 0) return `Ingen treningsdata for siste ${weeks} uker.`;
  const lines = [
    `Siste ${weeks} uker treningsdata (${acts.length} økter):`,
    '',
  ];
  for (const a of acts) {
    const km = (a.distance / 1000).toFixed(1);
    const min = Math.round(a.moving_time / 60);
    const hr = a.average_heartrate
      ? `, ${Math.round(a.average_heartrate)} bpm`
      : '';
    const maxHr = a.max_heartrate
      ? ` (maks ${Math.round(a.max_heartrate)})`
      : '';
    const pace =
      a.average_speed > 0
        ? `, ${formatPace(1000 / a.average_speed)}`
        : '';
    const elev = a.total_elevation_gain > 0
      ? `, +${Math.round(a.total_elevation_gain)}m`
      : '';

    lines.push(
      `- ${a.start_date.slice(0, 10)} ${a.type}: ${a.name ?? ''} – ${km} km / ${min} min${pace}${hr}${maxHr}${elev}`,
    );

    // Enrich with detail data if available
    const detail = a.detail_json ? JSON.parse(a.detail_json) : null;
    if (detail) {
      const extras: string[] = [];

      if (detail.description) {
        extras.push(`  Notater: ${detail.description}`);
      }

      if (detail.perceived_exertion) {
        extras.push(`  RPE: ${detail.perceived_exertion}/10`);
      }

      if (detail.average_cadence) {
        extras.push(`  Kadense: ${Math.round(detail.average_cadence * 2)} spm`);
      }

      if (detail.calories) {
        extras.push(`  Kalorier: ${Math.round(detail.calories)}`);
      }

      if (detail.workout_type != null) {
        const workoutTypes: Record<number, string> = {
          0: 'standard', 1: 'løp (konkurranse)', 2: 'langtur',
          3: 'intervall/fartlek', 11: 'tempo', 12: 'terskel',
        };
        const wt = workoutTypes[detail.workout_type];
        if (wt && detail.workout_type !== 0) extras.push(`  Økttype: ${wt}`);
      }

      // Laps — the key data for interval analysis
      if (detail.laps && detail.laps.length > 1) {
        extras.push(`  Intervaller (${detail.laps.length} laps):`);
        for (const lap of detail.laps) {
          const lapKm = (lap.distance / 1000).toFixed(2);
          const lapMin = Math.floor(lap.moving_time / 60);
          const lapSec = lap.moving_time % 60;
          const lapPace = lap.average_speed > 0
            ? formatPace(1000 / lap.average_speed)
            : '?';
          const lapHr = lap.average_heartrate
            ? `, ${Math.round(lap.average_heartrate)} bpm`
            : '';
          const lapMaxHr = lap.max_heartrate
            ? ` (maks ${Math.round(lap.max_heartrate)})`
            : '';
          extras.push(
            `    Lap ${lap.lap_index}: ${lapKm} km, ${lapMin}:${String(lapSec).padStart(2, '0')}, ${lapPace}${lapHr}${lapMaxHr}`,
          );
        }
      }

      // Splits per km — useful for steady-state runs
      if (detail.splits_metric && detail.splits_metric.length > 1 &&
          !(detail.laps && detail.laps.length > 1)) {
        extras.push(`  Km-splits:`);
        for (const split of detail.splits_metric) {
          const splitPace = split.average_speed > 0
            ? formatPace(1000 / split.average_speed)
            : '?';
          const splitHr = split.average_heartrate
            ? `, ${Math.round(split.average_heartrate)} bpm`
            : '';
          const splitElev = split.elevation_difference
            ? `, ${split.elevation_difference > 0 ? '+' : ''}${Math.round(split.elevation_difference)}m`
            : '';
          extras.push(
            `    Km ${split.split}: ${splitPace}${splitHr}${splitElev}`,
          );
        }
      }

      // Best efforts (PR-type data)
      if (detail.best_efforts && detail.best_efforts.length > 0) {
        const relevant = detail.best_efforts.filter((e: any) =>
          ['400m', '1/2 mile', '1k', '1 mile', '2 mile', '5k', '10k'].includes(e.name),
        );
        if (relevant.length > 0) {
          extras.push(`  Best efforts:`);
          for (const e of relevant) {
            const eMin = Math.floor(e.moving_time / 60);
            const eSec = e.moving_time % 60;
            extras.push(`    ${e.name}: ${eMin}:${String(eSec).padStart(2, '0')}`);
          }
        }
      }

      if (extras.length > 0) {
        lines.push(...extras);
      }
    }
  }
  return lines.join('\n');
}

function formatPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
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

// Formaterer de siste øktene som en ren tekstblokk klar til å lime inn i Claude.
function formatActivitiesForExport(acts: any[], maxHR: number): string {
  if (acts.length === 0) {
    return 'Ingen økter funnet. Synk fra Strava først.';
  }

  const blocks: string[] = [];
  blocks.push(
    `Treningsøkter (siste ${acts.length}, nyeste først). Soner basert på makspuls ${maxHR}.`,
  );

  acts.forEach((a, i) => {
    const raw = a.raw_json ? JSON.parse(a.raw_json) : {};
    const detail = a.detail_json ? JSON.parse(a.detail_json) : null;

    // Dato/klokkeslett: bruk lokal tid fra Strava når tilgjengelig
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

    // Tilleggsinfo (kun det som finnes)
    const meta: string[] = [];
    if (detail?.perceived_exertion) meta.push(`RPE: ${detail.perceived_exertion}/10`);
    if (detail?.average_cadence) meta.push(`Kadens: ${Math.round(detail.average_cadence * 2)} spm`);
    if (a.total_elevation_gain > 0) meta.push(`Høydemeter: +${Math.round(a.total_elevation_gain)} m`);
    if (detail?.workout_type != null && detail.workout_type !== 0) {
      const wt = WORKOUT_TYPES[detail.workout_type];
      if (wt) meta.push(`Økttype: ${wt}`);
    }
    if (meta.length > 0) lines.push(meta.join(' | '));

    // Runder (laps) med fart og puls
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

    // Totaltid i hver sone
    const zones = analyzeActivityZones(a, maxHR);
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
