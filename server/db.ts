import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '../data.db');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Schema. Holder det enkelt – vi har én bruker (deg).
db.exec(`
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

export type StravaTokens = {
  athlete_id: number;
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

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
    `INSERT OR REPLACE INTO activities
     (id, athlete_id, start_date, type, name, distance, moving_time,
      elapsed_time, total_elevation_gain, average_heartrate, max_heartrate,
      average_speed, raw_json, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

export function getLatestActivityDate(athleteId: number): string | undefined {
  const row = db
    .prepare(
      `SELECT start_date FROM activities
       WHERE athlete_id = ? ORDER BY start_date DESC LIMIT 1`,
    )
    .get(athleteId) as { start_date: string } | undefined;
  return row?.start_date;
}
