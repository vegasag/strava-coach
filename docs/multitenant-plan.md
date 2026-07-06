# Multi-tenant-plan: Strava Coach for familien

Mål: én app-instans som betjener flere personer (Vegard, Kristian, Eivind, Marie),
hver med egen Strava-tilkobling og egen makspuls/soner — pluss en admin-side som
lister alle og kan legge til nye.

## Beslutninger (avklart 2026-06-18)

| Spørsmål | Beslutning |
|---|---|
| Ruting | **Path-basert**: `strava-coach.fly.dev/kristian` osv. Subdomener på fly.dev er teknisk umulig (wildcard-DNS/-cert dekker kun ett nivå). Middleware-design gjør ekte subdomener via eget domene til en konfig-endring senere. |
| Strava-tilkobling | **Egen API-app per person.** Hver person oppretter nøkler på strava.com/settings/api (callback-domene: `strava-coach.fly.dev`) og admin legger inn client_id/secret ved opprettelse. Ingen egne URL-er — bare nøkler. Unngår Stravas athlete-grense og gir separate rate-kvoter (1000/dag hver). |
| Chat-funksjonen | **Fjernes.** Brukes ikke — kun eksport/kopiering brukes. Fjerner all Anthropic-kostnad og -risiko. Med den ryker også profilsystemet, filosofi-filene og `claude.ts` (alt eksisterte som chat-kontekst). |
| Månedlig sonetabell | **Fjernes** (brukes ikke). NB: «Tid i soner» per økt i eksporten **beholdes** — samme klassifisering (`analyzeActivityZones`), men del av eksportformatet. |
| Sikkerhet | Admin-side bak passord (Fly-secret `ADMIN_PASSWORD`). Tenant-sider: **PIN inngår i MVP**, med langlivet signert cookie (1 år) — tastes én gang per enhet, aldri igjen. Må være svært enkel på mobil (se 3). |
| Eksport-header | **Ja**: eksport-teksten innledes med personens makspuls og soneinndeling (bpm-grenser generert fra max_hr), slik at Claude-samtalen får riktig sonekontekst automatisk når teksten limes inn — erstatter filosofi-filenes rolle. |
| Mobil | **Hovedbruk er fra mobil.** Alle nye flater (PIN-skjerm, admin, onboarding, kopier-knapp) designes mobil-først. |

Appen etter ombygging: **koble Strava → sync → generer Claude-tekst → kopier.**
Ingen LLM-kall i appen selv; Claude-samtalen skjer i Claude-appen med limt inn tekst.

---

## Status i dag (relevant utgangspunkt)

- `activities` og `strava_tokens` er allerede nøklet på `athlete_id` — halvveis der.
- `getTokens()` har "single-user mode" (tar første rad) — må bort, alle kallsteder.
- Eksport-endepunktet `/api/export/claude` er kjernefunksjonen som skal bestå.
- Skal fjernes: `/api/chat`, `claude.ts`, `profile.ts` + endepunkter,
  `server/philosophy/`, `/api/analysis/zones` + sonetabell-UI, chat-UI,
  `ANTHROPIC_API_KEY`. (`analysis.ts` beholder kun `classifyHR`/`analyzeActivityZones`
  for eksporten.)

## 1. Datamodell (SQLite-migrasjoner)

```sql
CREATE TABLE IF NOT EXISTS tenants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT UNIQUE NOT NULL,      -- 'kristian', regex ^[a-z][a-z0-9-]{1,30}$
  display_name  TEXT NOT NULL,
  max_hr        INTEGER NOT NULL,          -- settes ved opprettelse (det unike per person)
  athlete_id    INTEGER UNIQUE,            -- NULL til første OAuth
  pin_hash      TEXT,                      -- valgfri (kan være NULL i MVP)
  strava_client_id     TEXT NOT NULL,      -- per-person API-app
  strava_client_secret TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
```

Endringer i eksisterende tabeller:
- `activities`: legg til `tenant_id INTEGER` + indeks `(tenant_id, start_date DESC)`.
- `strava_tokens`: nøkles om fra `athlete_id` til `tenant_id` (én rad per tenant).
- Migrasjonsskript: opprett tenant `vegard` (max_hr 200, athlete_id 27891592,
  dine nåværende env-nøkler som strava_client_id/secret), sett `tenant_id` på alle
  eksisterende rader. `user_profile.json` beholdes som død backup på volumet.

Reserverte slugs: `api`, `auth`, `admin`, `assets`, `favicon.ico`, `robots.txt`.

## 2. Backend (server/)

### 2.1 Tenant-middleware og ruter
- `resolveTenant`: (fremtidssikret) host-sjekk mot `BASE_DOMAIN`-env hvis satt →
  ellers første path-segment. Setter `tenant` på Hono-context. 404 ved ukjent slug.
- Rutestruktur:
  - `/` + `/admin/*` → admin (bak `ADMIN_PASSWORD`)
  - `/auth/strava/callback` → global; `state=slug:nonce` identifiserer tenant
  - `/:slug` → tenant-SPA
  - `/:slug/api/*` → tenant-scopede endepunkter: `status`, `sync`, `sync/deep`,
    `activities`, `export/claude`

### 2.2 Fil-for-fil
- **db.ts**: tenant-CRUD; `getTokens(tenantId)` (single-user-fallback fjernes);
  `saveActivity(tenantId, athleteId, raw)`; `getLatestActivities(tenantId, n)` osv.
- **strava.ts**: alle funksjoner tar credentials fra tenant;
  `getAuthorizeUrl(tenant, nonce)`; token-refresh per tenant.
- **analysis.ts**: slankes til `classifyHR` + `analyzeActivityZones` (for eksporten).
  `DEFAULT_MAX_HR` fjernes — maxHR kommer alltid fra tenant.
- **index.ts**: fjern chat/profil/zones-endepunkter; admin-endepunkter:
  `GET/POST /admin/api/tenants`, `DELETE /admin/api/tenants/:id`,
  `POST /admin/api/tenants/:id/sync`.
- **Eksport-header** (i `formatActivitiesForExport`): teksten innledes med en
  kontekstblokk generert fra tenanten, f.eks.:
  ```
  Løper: Kristian. Makspuls: 195 (verifisert).
  Soner (Bakken-modellen, % av makspuls):
    Rolig <70% (<137) | Grå 70–80% (137–156, unngås) |
    Terskel 80–87% (156–170) | Over terskel >87% (>170)
  ```
  Deretter øktene som i dag. Dette gjør hver kopiert tekst selvforsynt med
  riktig sonekontekst for Claude-samtalen.
- **Slettes**: `claude.ts`, `profile.ts`, `server/philosophy/`.
- **OAuth-flyt**: admin oppretter tenant (slug, navn, makspuls, client_id/secret) →
  første besøk på `/:slug` uten athlete_id viser «Koble til Strava» → OAuth med
  tenantens nøkler → callback lagrer tokens + athlete_id på tenanten.
  Athlete allerede koblet annet sted → tydelig feil (UNIQUE-constraint).

### 2.3 Sync
- Som i dag per tenant (knapp + admin-trigget). Separate Strava-kvoter per person
  gjør deep-sync ukomplisert — ingen kø nødvendig.

## 3. Frontend (src/)

- **Tenant-app** (slanket App.tsx): slug fra `location.pathname`; `api(path)`-helper
  som prefikser `/${slug}`. Beholder: øktliste, sync-knapp, eksport-seksjonen
  (dropdown 1–10 + generer + kopier). Fjerner: chat/Sparring, sonetabell.
  Onboarding-tilstand: tenant ikke koblet → «Koble til Strava»-knapp.
- **PIN-skjerm — mobil-først** (hovedbruk er mobil):
  - 4-sifret tall-PIN, `<input inputmode="numeric" pattern="[0-9]*">` →
    numerisk tastatur åpnes automatisk på iOS/Android
  - Store touch-flater, autofokus, auto-submit når 4 siffer er tastet
    (ingen egen «Logg inn»-knapp nødvendig)
  - Riktig PIN → signert cookie med 1 års levetid (`SameSite=Lax`, `Secure`,
    `HttpOnly`) — tastes aldri igjen på den enheten
  - Enkel brute force-brems (økende delay per feilforsøk per IP)
- **Admin-side** på `/`: tabell (navn, slug-lenke, tilkoblet?, antall økter,
  siste sync, makspuls) + «Legg til ny»-skjema (slug, navn, makspuls,
  client_id/secret, valgfri PIN) + handlinger (sync, slett).
  Kort hjelpetekst i skjemaet: «Slik lager du Strava-nøkler» (settings/api,
  callback-domene = strava-coach.fly.dev).
- Ruting uten router-lib: to sider + pathname-parsing holder.
  `prod.ts` SPA-fallback må servere index.html for `/:slug`.

## 4. Deploy/drift

- Path-ruting krever ingen Fly-endringer. Eget domene senere:
  `fly certs add "*.<domene>"` + CNAME + `BASE_DOMAIN`-env.
- Nye Fly-secrets: `ADMIN_PASSWORD`, `SESSION_SECRET` (cookie-signering).
  `ANTHROPIC_API_KEY` kan fjernes.
- Backup av `/data/data.db` mer verdt med fire personers data
  (enkleste: nattlig dump; bedre: Litestream mot S3-bøtte).

## 5. Gjennomføringsrekkefølge (commit-vennlige steg)

1. **Rydding**: fjern chat, profil, filosofi, sonetabell (backend + frontend + secrets).
   Appen blir liten og oversiktlig FØR ombygging. Testbart: eksport funker som før.
2. **DB-grunnmur**: tenants-tabell, migrasjoner, tenant_id, om-nøkling av tokens,
   migrasjonsskript for `vegard`. (Ingen synlig endring.)
3. **Tenant-scoping backend**: middleware, endepunkter, OAuth med state og
   per-tenant nøkler. Testbart med curl mot `/vegard/api/...`.
4. **Frontend**: slug-basert app + onboarding + admin-side.
5. **Sikkerhet**: admin-passord + PIN med 1-års cookie (inngår i MVP).
6. **Onboard familien**: hver lager Strava-nøkler, admin oppretter tenants, kobler til.

Steg 1 gjør alt etterpå enklere og kan gjøres i dag uten avklaringer.

## 6. Utvidelsesidéer (etter MVP)

- **Strava webhooks / cron-sync**: auto-sync uten knappetrykk (webhook per API-app,
  eller enklere: GitHub Action/Fly cron som kaller sync per tenant hver time).
- **Eget domene**: `kristian.coach.<domene>` via wildcard-cert (ren konfig).
- **Familie-dashboard**: ukesvolum/terskelminutter på tvers (krever samtykke-avklaring).
- **PWA-forbedringer**: brukes nok mest på mobil.
- **Eksport-varianter**: velg datospenn i stedet for antall; «kun kvalitetsøkter»-filter.
- **Gjeninnføre chat** senere hvis ønsket — da gjelder gamle planens punkter om
  per-tenant profil, delt prompt-cache og PIN foran chat-endepunktet.

## 7. Åpne spørsmål

Ingen — alle beslutninger er tatt (se beslutningstabellen øverst).
Planen er klar til gjennomføring, steg for steg fra seksjon 5.
