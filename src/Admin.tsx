import { useEffect, useState } from 'react';

type TenantRow = {
  id: number;
  slug: string;
  display_name: string;
  max_hr: number;
  connected: boolean;
  activity_count: number;
  last_activity: string | null;
  has_own_creds: boolean;
  show_gear: boolean;
};

export function Admin() {
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [needLogin, setNeedLogin] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function load() {
    const r = await fetch('/admin/api/tenants');
    if (r.status === 401) {
      setNeedLogin(true);
      setLoading(false);
      return;
    }
    const d = await r.json();
    setTenants(d.tenants ?? []);
    setNeedLogin(false);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  if (needLogin) return <AdminLogin onSuccess={load} />;

  async function syncTenant(id: number) {
    setBusyId(id);
    try {
      await fetch(`/admin/api/tenants/${id}/sync`, { method: 'POST' });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function toggleGear(id: number, value: boolean) {
    setTenants((prev) =>
      prev.map((t) => (t.id === id ? { ...t, show_gear: value } : t)),
    );
    await fetch(`/admin/api/tenants/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ show_gear: value }),
    });
  }

  async function deleteTenant(id: number, name: string) {
    if (!confirm(`Slette ${name} og alle øktene? Kan ikke angres.`)) return;
    setBusyId(id);
    try {
      await fetch(`/admin/api/tenants/${id}`, { method: 'DELETE' });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <div className="container">Laster…</div>;

  return (
    <div className="container">
      <header>
        <h1>Strava Coach – oversikt</h1>
        <button className="btn primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Lukk' : 'Legg til'}
        </button>
      </header>

      {showForm && (
        <AddTenantForm
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      )}

      <ul className="tenant-list">
        {tenants.map((t) => (
          <li key={t.id} className="tenant-card">
            <div className="tenant-main">
              <a className="tenant-name" href={`/${t.slug}`}>
                {t.display_name}
              </a>
              <span className="tenant-slug">/{t.slug}</span>
            </div>
            <div className="tenant-meta">
              <span className={t.connected ? 'badge ok' : 'badge off'}>
                {t.connected ? 'Tilkoblet' : 'Ikke tilkoblet'}
              </span>
              <span>Maks {t.max_hr}</span>
              <span>{t.activity_count} økter</span>
              {t.last_activity && (
                <span>Sist: {t.last_activity.slice(0, 10)}</span>
              )}
            </div>
            <label className="tenant-toggle">
              <input
                type="checkbox"
                checked={t.show_gear}
                onChange={(e) => toggleGear(t.id, e.target.checked)}
              />
              Ta med sko i eksporten
            </label>
            <div className="tenant-actions">
              {t.connected ? (
                <button
                  className="btn"
                  onClick={() => syncTenant(t.id)}
                  disabled={busyId === t.id}
                >
                  {busyId === t.id ? 'Synker…' : 'Synk'}
                </button>
              ) : (
                <a className="btn" href={`/${t.slug}/auth/strava`}>
                  Koble til Strava
                </a>
              )}
              <a className="btn" href={`/${t.slug}`}>
                Åpne
              </a>
              <button
                className="btn danger"
                onClick={() => deleteTenant(t.id, t.display_name)}
                disabled={busyId === t.id}
              >
                Slett
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AdminLogin({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await fetch('/admin/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!r.ok) {
        setError('Feil passord');
        return;
      }
      onSuccess();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container">
      <h1>Admin</h1>
      <form className="add-form" onSubmit={submit}>
        <label>
          Passord
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Logger inn…' : 'Logg inn'}
        </button>
      </form>
    </div>
  );
}

function AddTenantForm({ onCreated }: { onCreated: () => void }) {
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [maxHr, setMaxHr] = useState('195');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const r = await fetch('/admin/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: slug.trim(),
          display_name: displayName.trim(),
          max_hr: Number(maxHr),
          strava_client_id: clientId.trim() || null,
          strava_client_secret: clientSecret.trim() || null,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error ?? 'Kunne ikke opprette');
        return;
      }
      onCreated();
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="add-form" onSubmit={submit}>
      <label>
        Navn
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Kristian"
          required
        />
      </label>
      <label>
        Lenke (slug)
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          placeholder="kristian"
          pattern="[a-z][a-z0-9-]{1,30}"
          required
        />
      </label>
      <label>
        Makspuls
        <input
          type="number"
          inputMode="numeric"
          value={maxHr}
          onChange={(e) => setMaxHr(e.target.value)}
          required
        />
      </label>
      <details className="add-form-advanced">
        <summary>Egne Strava-nøkler (valgfritt)</summary>
        <p className="hint">
          Lag på strava.com/settings/api (callback-domene:
          strava-coach.fly.dev). La stå tomt for å bruke felles nøkler.
        </p>
        <label>
          Client ID
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </label>
        <label>
          Client Secret
          <input
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </label>
      </details>
      {error && <p className="form-error">{error}</p>}
      <button className="btn primary" type="submit" disabled={saving}>
        {saving ? 'Lagrer…' : 'Opprett'}
      </button>
    </form>
  );
}
