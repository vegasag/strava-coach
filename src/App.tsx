import { useEffect, useRef, useState } from 'react';

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

type ChatMsg = {
  role: 'user' | 'assistant';
  content: string;
  saved?: { section: string; content: string }[];
};

type MonthZone = {
  month: string;
  total_runs: number;
  total_time_min: number;
  total_distance_km: number;
  easy_min: number;
  gray_min: number;
  threshold_min: number;
  above_min: number;
  easy_pct: number;
  gray_pct: number;
  threshold_pct: number;
  above_pct: number;
  unclassified_min: number;
};

export function App() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [zones, setZones] = useState<MonthZone[]>([]);
  const [showZones, setShowZones] = useState(false);

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

  async function loadZones() {
    const r = await fetch('/api/analysis/zones');
    const d = await r.json();
    setZones((d.months ?? []).reverse());
    setShowZones(true);
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

  async function send() {
    if (!input.trim()) return;
    const next: ChatMsg[] = [...messages, { role: 'user', content: input }];
    setMessages(next);
    setInput('');
    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next, weeks_context: 8 }),
        signal: controller.signal,
      });
      const d = await r.json();
      if (d.error) {
        setMessages([...next, { role: 'assistant', content: `Feil: ${d.error}` }]);
      } else {
        setMessages([
          ...next,
          { role: 'assistant', content: d.text, saved: d.saved },
        ]);
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        setMessages(next.slice(0, -1));
      } else {
        setMessages([...next, { role: 'assistant', content: `Feil: ${e.message}` }]);
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
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
          <h2>Sonefordeling</h2>
          <button className="btn" onClick={loadZones}>
            {showZones ? 'Oppdater' : 'Vis sonefordeling'}
          </button>
        </div>
        {showZones && zones.length > 0 && (
          <div className="zone-table-wrap">
            <table className="zone-table">
              <thead>
                <tr>
                  <th>Måned</th>
                  <th>Økter</th>
                  <th>Tid</th>
                  <th>Km</th>
                  <th className="zone-col">Rolig</th>
                  <th className="zone-col">Grå</th>
                  <th className="zone-col">Terskel</th>
                  <th className="zone-col">Over</th>
                </tr>
              </thead>
              <tbody>
                {zones.map((z) => (
                  <tr key={z.month}>
                    <td className="month-cell">{z.month}</td>
                    <td>{z.total_runs}</td>
                    <td>{formatHours(z.total_time_min)}</td>
                    <td>{z.total_distance_km}</td>
                    <td>
                      <div className="zone-bar">
                        <div
                          className="bar easy"
                          style={{ width: `${z.easy_pct}%` }}
                        />
                        <span className="pct">{z.easy_pct}%</span>
                      </div>
                    </td>
                    <td>
                      <div className="zone-bar">
                        <div
                          className="bar gray"
                          style={{ width: `${z.gray_pct}%` }}
                        />
                        <span className="pct">{z.gray_pct}%</span>
                      </div>
                    </td>
                    <td>
                      <div className="zone-bar">
                        <div
                          className="bar threshold"
                          style={{ width: `${z.threshold_pct}%` }}
                        />
                        <span className="pct">{z.threshold_pct}%</span>
                      </div>
                    </td>
                    <td>
                      <div className="zone-bar">
                        <div
                          className="bar above"
                          style={{ width: `${z.above_pct}%` }}
                        />
                        <span className="pct">{z.above_pct}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2>Sparring</h2>
        <div className="chat">
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className="role">{m.role === 'user' ? 'Du' : 'Claude'}</div>
              <div className="content">{m.content}</div>
              {m.saved && m.saved.length > 0 && (
                <div className="saved-indicator">
                  {m.saved.map((s, j) => (
                    <div key={j} className="saved-item">
                      Lagret til <strong>{s.section}</strong>: {s.content}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {loading && (
            <div className="msg assistant thinking">
              <span>Tenker…</span>
              <button className="btn cancel" onClick={cancel}>Avbryt</button>
            </div>
          )}
        </div>
        <div className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Spør om treningen din…"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
            }}
          />
          <button className="btn primary" onClick={send} disabled={loading}>
            Send (⌘+Enter)
          </button>
        </div>
      </section>
    </div>
  );
}

function formatPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
}

function formatHours(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}t${m > 0 ? ` ${m}m` : ''}` : `${m}m`;
}
