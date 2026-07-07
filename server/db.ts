import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.resolve(__dirname, '../data.db');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Schema.
db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    max_hr INTEGER NOT NULL,
    athlete_id INTEGER UNIQUE,
    pin_hash TEXT,
    strava_client_id TEXT,
    strava_client_secret TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS strava_tokens (
    athlete_id INTEGER PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY,
    athlete_id INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT,
    distance REAL,
    moving_time INTEGER,
    elapsed_time INTEGER,
    total_elevation_gain REAL,
    average_heartrate REAL,
    max_heartrate REAL,
    average_speed REAL,
    raw_json TEXT NOT NULL,
    detail_json TEXT,
    fetched_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_activities_date
    ON activities(athlete_id, start_date DESC);
`);

// Migration: add detail_json if missing (existing DBs)
try {
  db.exec(`ALTER TABLE activities ADD COLUMN detail_json TEXT`);
} catch {
  // column already exists
}

// Migration: multi-tenant columns (additive; existing single-user data stays valid)
try {
  db.exec(`ALTER TABLE activities ADD COLUMN tenant_id INTEGER`);
} catch {
  // column already exists
}
try {
  db.exec(`ALTER TABLE strava_tokens ADD COLUMN tenant_id INTEGER`);
} catch {
  // column already exists
}
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_activities_tenant
   ON activities(tenant_id, start_date DESC)`,
);

export type StravaTokens = {
  athlete_id: number;
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

export type Tenant = {
  id: number;
  slug: string;
  display_name: string;
  max_hr: number;
  athlete_id: number | null;
  pin_hash: string | null;
  strava_client_id: string | null;
  strava_client_secret: string | null;
  created_at: number;
};

export function createTenant(t: {
  slug: string;
  display_name: string;
  max_hr: number;
  strava_client_id?: string | null;
  strava_client_secret?: string | null;
  pin_hash?: string | null;
}): Tenant {
  const info = db
    .prepare(
      `INSERT INTO tenants
       (slug, display_name, max_hr, strava_client_id, strava_client_secret, pin_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.slug,
      t.display_name,
      t.max_hr,
      t.strava_client_id ?? null,
      t.strava_client_secret ?? null,
      t.pin_hash ?? null,
      Date.now(),
    );
  return getTenantById(Number(info.lastInsertRowid))!;
}

export function getTenantById(id: number): Tenant | undefined {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as
    | Tenant
    | undefined;
}

export function getTenantBySlug(slug: string): Tenant | undefined {
  return db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug) as
    | Tenant
    | undefined;
}

export function getTenantByAthleteId(athleteId: number): Tenant | undefined {
  return db
    .prepare('SELECT * FROM tenants WHERE athlete_id = ?')
    .get(athleteId) as Tenant | undefined;
}

export function listTenants(): Tenant[] {
  return db
    .prepare('SELECT * FROM tenants ORDER BY created_at ASC')
    .all() as Tenant[];
}

export function setTenantAthleteId(tenantId: number, athleteId: number) {
  db.prepare('UPDATE tenants SET athlete_id = ? WHERE id = ?').run(
    athleteId,
    tenantId,
  );
}

export function saveTokens(t: StravaTokens) {
  db.prepare(
    `INSERT OR REPLACE INTO strava_tokens
     (athlete_id, access_token, refresh_token, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).run(t.athlete_id, t.access_token, t.refresh_token, t.expires_at);
}

export function getTokens(athleteId?: number): StravaTokens | undefined {
  if (athleteId) {
    return db
      .prepare('SELECT * FROM strava_tokens WHERE athlete_id = ?')
      .get(athleteId) as StravaTokens | undefined;
  }
  // Single-user mode: bare ta første raden
  return db.prepare('SELECT * FROM strava_tokens LIMIT 1').get() as
    | StravaTokens
    | undefined;
}

export function saveActivity(athleteId: number, raw: any) {
  db.prepare(
    `INSERT INTO activities
     (id, athlete_id, start_date, type, name, distance, moving_time,
      elapsed_time, total_elevation_gain, average_heartrate, max_heartrate,
      average_speed, raw_json, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
      start_date = excluded.start_date,
      type = excluded.type,
      name = excluded.name,
      distance = excluded.distance,
      moving_time = excluded.moving_time,
      elapsed_time = excluded.elapsed_time,
      total_elevation_gain = excluded.total_elevation_gain,
      average_heartrate = excluded.average_heartrate,
      max_heartrate = excluded.max_heartrate,
      average_speed = excluded.average_speed,
      raw_json = excluded.raw_json,
      fetched_at = excluded.fetched_at`,
  ).run(
    raw.id,
    athleteId,
    raw.start_date,
    raw.type,
    raw.name,
    raw.distance,
    raw.moving_time,
    raw.elapsed_time,
    raw.total_elevation_gain,
    raw.average_heartrate ?? null,
    raw.max_heartrate ?? null,
    raw.average_speed,
    JSON.stringify(raw),
    Date.now(),
  );
}

export function saveActivityDetail(activityId: number, detail: any) {
  db.prepare(
    `UPDATE activities SET detail_json = ? WHERE id = ?`,
  ).run(JSON.stringify(detail), activityId);
}

export function getActivitiesWithoutDetail(athleteId: number): number[] {
  const rows = db
    .prepare(
      `SELECT id FROM activities
       WHERE athlete_id = ? AND detail_json IS NULL
       ORDER BY start_date DESC`,
    )
    .all(athleteId) as { id: number }[];
  return rows.map((r) => r.id);
}

export function getRecentActivities(athleteId: number, sinceDate: string) {
  return db
    .prepare(
      `SELECT * FROM activities
       WHERE athlete_id = ? AND start_date >= ?
       ORDER BY start_date DESC`,
    )
    .all(athleteId, sinceDate) as any[];
}

export function getLatestActivities(athleteId: number, limit: number) {
  return db
    .prepare(
      `SELECT * FROM activities
       WHERE athlete_id = ?
       ORDER BY start_date DESC
       LIMIT ?`,
    )
    .all(athleteId, limit) as any[];
}

export function getLatestActivityDate(athleteId: number): string | undefined {
  const row = db
    .prepare(
      `SELECT start_date FROM activities
       WHERE athlete_id = ? ORDER BY start_date DESC LIMIT 1`,
    )
    .get(athleteId) as { start_date: string } | undefined;
  return row?.start_date;
}

// One-time migration: turn the existing single-user DB into tenant "vegard".
// Idempotent — runs only when no tenants exist yet AND there is existing data.
function migrateToMultiTenant() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM tenants').get() as {
    n: number;
  };
  if (n > 0) return;

  const tok = db.prepare('SELECT * FROM strava_tokens LIMIT 1').get() as
    | StravaTokens
    | undefined;
  if (!tok) return; // fresh DB — nothing to migrate

  const tenant = createTenant({
    slug: 'vegard',
    display_name: 'Vegard',
    max_hr: 200,
    strava_client_id: process.env.STRAVA_CLIENT_ID ?? null,
    strava_client_secret: process.env.STRAVA_CLIENT_SECRET ?? null,
  });
  setTenantAthleteId(tenant.id, tok.athlete_id);
  db.prepare('UPDATE activities SET tenant_id = ? WHERE tenant_id IS NULL').run(
    tenant.id,
  );
  db.prepare('UPDATE strava_tokens SET tenant_id = ? WHERE athlete_id = ?').run(
    tenant.id,
    tok.athlete_id,
  );
}

migrateToMultiTenant();
