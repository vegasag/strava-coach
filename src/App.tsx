import { useEffect, useState } from 'react';

type Activity = {
  id: number;
  date: string;
  type: string;
  name: string;
  distance_km: number;
  moving_time_s: number;
  avg_hr: number | null;
  max_hr: number | null;
  avg_pace_s_per_km: number | null;
};

type Status =
  | { state: 'loading' }
  | { state: 'unknown' }
  | {
      state: 'ready';
      connected: boolean;
      display_name: string;
      pin_required: boolean;
      authed: boolean;
    };

export function TenantApp({ slug }: { slug: string }) {
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [activities, setActivities] = useState<Activity[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [exportCount, setExportCount] = useState(5);
  const [exportText, setExportText] = useState('');
  const [exportLoading, setExportLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const api = (path: string) => `/${slug}${path}`;

  function loadStatus() {
    fetch(api('/api/status'))
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) =>
        setStatus({
          state: 'ready',
          connected: d.connected,
          display_name: d.display_name,
          pin_required: d.pin_required,
          authed: d.authed,
        }),
      )
      .catch(() => setStatus({ state: 'unknown' }));
  }

  useEffect(() => {
    loadStatus();
  }, [slug]);

  useEffect(() => {
    if (
      status.state === 'ready' &&
      status.connected &&
      (!status.pin_required || status.authed)
    ) {
      loadActivities();
    }
  }, [status]);

  async function loadActivities() {
    const r = await fetch(api('/api/activities?weeks=8'));
    const d = await r.json();
    setActivities(d.activities ?? []);
  }

  async function generateExport() {
    setExportLoading(true);
    setCopied(false);
    try {
      const r = await fetch(api(`/api/export/claude?count=${exportCount}`));
      const d = await r.json();
      setExportText(d.text ?? d.error ?? '');
    } catch (e: any) {
      setExportText(`Feil: ${e.message}`);
    } finally {
      setExportLoading(false);
    }
  }

  async function copyExport() {
    try {
      await navigator.clipboard.writeText(exportText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard kan være blokkert – brukeren kan markere teksten manuelt
    }
  }

  async function sync() {
    setSyncing(true);
    try {
      await fetch(api('/api/sync'), { method: 'POST' });
      await loadActivities();
    } finally {
      setSyncing(false);
    }
  }

  if (status.state === 'loading') {
    return <div className="container">Laster…</div>;
  }

  if (status.state === 'unknown') {
    return (
      <div className="container">
        <h1>Strava Coach</h1>
        <p>Fant ingen bruker «{slug}».</p>
        <a className="btn" href="/">
          Til oversikten
        </a>
      </div>
    );
  }

  if (status.pin_required && !status.authed) {
    return (
      <PinScreen
        slug={slug}
        name={status.display_name}
        onSuccess={loadStatus}
      />
    );
  }

  if (!status.connected) {
    return (
      <div className="container">
        <h1>{status.display_name}</h1>
        <p>Koble til Strava for å starte.</p>
        <a className="btn primary" href={`/${slug}/auth/strava`}>
          Koble til Strava
        </a>
      </div>
    );
  }

  return (
    <div className="container">
      <header>
        <h1>{status.display_name}</h1>
        <button className="btn" onClick={sync} disabled={syncing}>
          {syncing ? 'Synkroniserer…' : 'Hent nye økter'}
        </button>
      </header>

      <section>
        <h2>Siste 8 uker ({activities.length} økter)</h2>
        <ul className="activities">
          {activities.map((a) => (
            <li key={a.id}>
              <strong>{a.date.slice(0, 10)}</strong> – {a.type} – {a.name}
              <br />
              <small>
                {a.distance_km.toFixed(1)} km / {Math.round(a.moving_time_s / 60)} min
                {a.avg_hr ? ` · ${Math.round(a.avg_hr)} bpm` : ''}
                {a.avg_pace_s_per_km
                  ? ` · ${formatPace(a.avg_pace_s_per_km)}`
                  : ''}
              </small>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="section-header">
          <h2>Claude-info om økter</h2>
          <div className="export-controls">
            <label>
              Antall:
              <select
                value={exportCount}
                onChange={(e) => setExportCount(Number(e.target.value))}
              >
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn"
              onClick={generateExport}
              disabled={exportLoading}
            >
              {exportLoading ? 'Henter…' : 'Lag Claude-info om treningsøkter'}
            </button>
          </div>
        </div>
        {exportText && (
          <div className="export-output">
            <div className="export-output-header">
              <span className="export-hint">
                Kopier og lim inn i samtalen din med Claude.
              </span>
              <button className="btn" onClick={copyExport}>
                {copied ? 'Kopiert ✓' : 'Kopier'}
              </button>
            </div>
            <textarea className="export-text" readOnly value={exportText} />
          </div>
        )}
      </section>
    </div>
  );
}

function PinScreen({
  slug,
  name,
  onSuccess,
}: {
  slug: string;
  name: string;
  onSuccess: () => void;
}) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(value: string) {
    setBusy(true);
    setError(false);
    try {
      const r = await fetch(`/${slug}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: value }),
      });
      if (!r.ok) {
        setError(true);
        setPin('');
        return;
      }
      onSuccess();
    } finally {
      setBusy(false);
    }
  }

  function onChange(v: string) {
    const digits = v.replace(/\D/g, '').slice(0, 4);
    setPin(digits);
    if (digits.length === 4) submit(digits); // auto-submit ved 4 siffer
  }

  return (
    <div className="container pin-screen">
      <h1>{name}</h1>
      <p>Skriv inn PIN-koden.</p>
      <input
        className="pin-input"
        inputMode="numeric"
        pattern="[0-9]*"
        autoFocus
        value={pin}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        placeholder="••••"
      />
      {error && <p className="form-error">Feil PIN. Prøv igjen.</p>}
    </div>
  );
}

function formatPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
}
