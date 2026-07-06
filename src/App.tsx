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

export function App() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [exportCount, setExportCount] = useState(5);
  const [exportText, setExportText] = useState('');
  const [exportLoading, setExportLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/status')
      .then((r) => r.json())
      .then((d) => setConnected(d.connected));
  }, []);

  useEffect(() => {
    if (connected) loadActivities();
  }, [connected]);

  async function loadActivities() {
    const r = await fetch('/api/activities?weeks=8');
    const d = await r.json();
    setActivities(d.activities ?? []);
  }

  async function generateExport() {
    setExportLoading(true);
    setCopied(false);
    try {
      const r = await fetch(`/api/export/claude?count=${exportCount}`);
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
      await fetch('/api/sync', { method: 'POST' });
      await loadActivities();
    } finally {
      setSyncing(false);
    }
  }

  if (connected === null) return <div className="container">Laster…</div>;

  if (!connected) {
    return (
      <div className="container">
        <h1>Strava Coach</h1>
        <p>Koble til Strava for å starte.</p>
        <a className="btn primary" href="/auth/strava">
          Koble til Strava
        </a>
      </div>
    );
  }

  return (
    <div className="container">
      <header>
        <h1>Strava Coach</h1>
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

function formatPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
}
