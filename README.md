# Strava Coach

Lokal sparrings-app: Strava-data + Claude-chat.

## Oppstart

1. **Installer deps**
   ```bash
   npm install
   ```

2. **Lag .env**
   ```bash
   cp .env.example .env
   ```
   Fyll inn:
   - `STRAVA_CLIENT_ID` og `STRAVA_CLIENT_SECRET` fra https://developers.strava.com (din app)
   - `ANTHROPIC_API_KEY` fra https://console.anthropic.com
   - `SESSION_SECRET`: kjør `openssl rand -hex 32`

3. **Sjekk Strava-app innstillinger**
   - Authorization Callback Domain: `localhost` (kun domenet, ingen path/port)

4. **Start**
   ```bash
   npm run dev
   ```
   Åpne http://localhost:3000

## Flyt

1. Klikk "Koble til Strava" → autoriser
2. Klikk "Hent nye økter" → synker siste 90 dager (første gang), inkrementelt etter
3. Spør Claude i chatten – konteksten (siste 8 uker) sendes automatisk

## Filstruktur

```
src/             # React frontend
  App.tsx
  main.tsx
  styles.css
server/          # Hono backend (kjører som Vite middleware)
  index.ts       # Ruter
  strava.ts      # Strava OAuth + API
  claude.ts      # Anthropic SDK
  db.ts          # SQLite (better-sqlite3)
data.db          # Opprettes automatisk
.env             # IKKE committ
```

## Utvide

- **Streams (puls/tempo per sekund)**: Legg til endepunkt i `strava.ts` for `/activities/{id}/streams`. Brukbart for å analysere terskeløkter detaljert.
- **Laps**: Strava-aktiviteter har laps – legg til egen tabell og hent ved behov.
- **Bakken-bok som kontekst**: Lim inn relevante sider i `SYSTEM_PROMPT` i `claude.ts` (eller last fra fil).
