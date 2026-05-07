import { saveTokens, getTokens, type StravaTokens } from './db.js';

const STRAVA_API = 'https://www.strava.com/api/v3';
const STRAVA_OAUTH = 'https://www.strava.com/oauth/token';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export function getAuthorizeUrl(): string {
  const params = new URLSearchParams({
    client_id: env('STRAVA_CLIENT_ID'),
    redirect_uri: env('STRAVA_REDIRECT_URI'),
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
  });
  return `https://www.strava.com/oauth/authorize?${params}`;
}

export async function exchangeCodeForToken(code: string) {
  const res = await fetch(STRAVA_OAUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env('STRAVA_CLIENT_ID'),
      client_secret: env('STRAVA_CLIENT_SECRET'),
      code,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Strava token exchange failed: ${res.status}`);
  const data: any = await res.json();
  const tokens: StravaTokens = {
    athlete_id: data.athlete.id,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
  };
  saveTokens(tokens);
  return tokens;
}

async function refreshIfNeeded(tokens: StravaTokens): Promise<StravaTokens> {
  const now = Math.floor(Date.now() / 1000);
  if (tokens.expires_at > now + 60) return tokens;

  const res = await fetch(STRAVA_OAUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env('STRAVA_CLIENT_ID'),
      client_secret: env('STRAVA_CLIENT_SECRET'),
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!res.ok) throw new Error(`Strava refresh failed: ${res.status}`);
  const data: any = await res.json();
  const updated: StravaTokens = {
    athlete_id: tokens.athlete_id,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
  };
  saveTokens(updated);
  return updated;
}

async function authedFetch(path: string, params?: Record<string, string>) {
  const tokens = getTokens();
  if (!tokens) throw new Error('Not authenticated with Strava');
  const fresh = await refreshIfNeeded(tokens);

  const url = new URL(`${STRAVA_API}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${fresh.access_token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strava ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

export async function listActivities(opts: {
  after?: number; // unix timestamp
  page?: number;
  per_page?: number;
}) {
  const params: Record<string, string> = {
    per_page: String(opts.per_page ?? 50),
    page: String(opts.page ?? 1),
  };
  if (opts.after) params.after = String(opts.after);
  return authedFetch('/athlete/activities', params) as Promise<any[]>;
}

export async function getActivityDetail(id: number) {
  return authedFetch(`/activities/${id}`);
}
