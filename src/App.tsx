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
      activity_count: number;
    };

export function TenantApp({ slug }: { slug: string }) {
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [activities, setActivities] = useState<Activity[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [exportCount, setExportCount] = useState(5);
  const [exportText, setExportText] = useState('');
  const [exportLoading, setExportLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState('');

  const api = (path: string) => `/${slug}${path}`;

  function loadStatus() {
    fetch(api('/api/status'))
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) =>
        setStatus({
          state: 'ready',
          connected: d.connected,
          display_name: d.display_name,
          activity_count: d.activity_count ?? 0,
        }),
      )
      .catch(() => setStatus({ state: 'unknown' }));
  }

  useEffect(() => {
    loadStatus();
  }, [slug]);

  useEffect(() => {
    if (status.state === 'ready' && status.connected) loadActivities();
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
      loadStatus();
    } finally {
      setSyncing(false);
    }
  }

  async function importHistory() {
    setImporting(true);
    setImportResult('');
    try {
      const r = await fetch(api('/api/import'), { method: 'POST' });
      const d = await r.json();
      if (d.error) {
        setImportResult(`Feil: ${d.error}`);
        return;
      }
      setImportResult(
        `Importerte ${d.synced} økter. ${
          d.remaining > 0
            ? `${d.remaining} mangler detaljer – trykk «Hent nye økter» igjen senere.`
            : 'Alle detaljer hentet.'
        }`,
      );
      await loadActivities();
      loadStatus();
    } catch (e: any) {
      setImportResult(`Feil: ${e.message}`);
    } finally {
      setImporting(false);
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

      {status.activity_count <= 10 && (
        <section className="import-box">
          <h2>Importer historiske data</h2>
          <p className="import-hint">
            Du har {status.activity_count} økter lagret. Hent inn opptil 500
            tidligere økter fra Strava. Dette tar litt tid.
          </p>
          <button
            className="btn primary"
            onClick={importHistory}
            disabled={importing}
          >
            {importing ? 'Importerer…' : 'Importer historiske data'}
          </button>
          {importResult && <p className="import-result">{importResult}</p>}
        </section>
      )}

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
