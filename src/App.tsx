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

type ChatMsg = {
  role: 'user' | 'assistant';
  content: string;
  saved?: { section: string; content: string }[];
};

export function App() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

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
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next, weeks_context: 8 }),
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
    } finally {
      setLoading(false);
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
          {loading && <div className="msg assistant">Tenker…</div>}
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
