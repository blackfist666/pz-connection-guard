# pz-connection-guard

Two small Node.js services for a self-hosted [Project Zomboid](https://projectzomboid.com/) dedicated server, built to cut down on troll connections and ban-evasion via throwaway Steam accounts.

The problem this was built for: a player gets banned, buys or spins up a new Steam account, and reconnects a few minutes later as if nothing happened. Manually eyeballing every join in the console log doesn't scale. These two services automate the eyeball check — every new connection is screened against its Steam profile and IP before it's allowed to stay.

## How it works

```
Zomboid server-console.txt
        │  (tailed for join/disconnect lines)
        ▼
  steviewonder  ──────────────►  steamchecker  ──────► Steam Web API
  (log watcher,                  (local REST API)  ──► ipinfo.io
   RCON enforcer)
        │
        ▼
   mcrcon → kick / ban
```

**steamchecker** is a small Express API that, given a SteamID64 and an IP, looks up:
- the player's Steam profile (via the Steam Web API) — account creation date, friend count, whether the profile is public, Steam-registered country
- the IP's geolocation (via [ipinfo.io](https://ipinfo.io))

It also holds a local whitelist file so trusted/known players always short-circuit to an allow, without spending API calls.

**steviewonder** tails the Zomboid server's `server-console.txt` in real time. When it sees a player join:
1. It pulls the SteamID, username, and connecting IP out of the log line.
2. It asks steamchecker's `/whitelist/:steamId` endpoint first — if whitelisted, the player is left alone.
3. Otherwise it asks steamchecker's `/check/:steamId/:ip` endpoint and evaluates the result against configurable rules (minimum account age, minimum friend count, optional Steam-country vs IP-country mismatch).
4. If the player fails, steviewonder schedules two delayed kicks (not an instant kick — the delay gives real players with a slow Steam API response a chance, and makes the process feel less like an instant auto-ban to legitimate new players). Each kick is issued over RCON via [mcrcon](https://github.com/Tiiffi/mcrcon).
5. If a SteamID racks up enough kicks within a rolling 1-hour window, steviewonder escalates to a full `banid` over RCON — this is what catches an account that keeps rejoining.
6. Every decision is written to a daily, date-stamped audit log so you can review what happened after the fact.

Everything is a pass/fail heuristic, not a guarantee — the goal is raising the cost of ban evasion (new profile, aged 8+ years, 15+ friends, not private) high enough that it stops being worth it for casual trolls, while leaving genuine new players alone via the whitelist and the kick-before-ban grace period.

## Requirements

- Node.js
- [mcrcon](https://github.com/Tiiffi/mcrcon) installed and on `PATH` on the machine running steviewonder
- RCON enabled on the Zomboid server (`RCONPort` / `RCONPassword` in the server's `.ini`)
- A [Steam Web API key](https://steamcommunity.com/dev/apikey)
- An [ipinfo.io](https://ipinfo.io) API token (the free tier is enough for a small server)

## Setup

### 1. steamchecker (run this first)

```
cd steamchecker
npm install
cp .env.example .env   # then fill in STEAM_API_KEY and IPINFO_TOKEN
```

Populate `stevies_list.txt` with one SteamID64 per line for anyone who should always be allowed through without checks.

Start it (loads env vars from your shell/process manager — there's no dotenv loader, so `export` them or use something like `pm2`/`systemd` with an `EnvironmentFile`):

```
npm start
```

It listens on `PORT` (default `3000`).

### 2. steviewonder

```
cd steviewonder
npm install
cp .env.example .env   # then fill in the values below
```

| Variable | Purpose | Default |
|---|---|---|
| `ZOMBOID_LOG_PATH` | Path to the server's `server-console.txt` | `/home/pzserver/Zomboid/server-console.txt` |
| `RCON_HOST` | Host running the Zomboid server's RCON listener | `localhost` |
| `RCON_PORT` | RCON port | `27015` |
| `RCON_PASSWORD` | RCON password (**required**, no default — the process refuses to start without it) | — |
| `STEAMCHECKER_URL` | Base URL of the steamchecker service | `http://127.0.0.1:3000` |

Start it:

```
npm start
```

### 3. Tune the rules

The screening thresholds live as constants at the top of `steviewonder/steviewonder.js`:

| Constant | Meaning |
|---|---|
| `MIN_ACCOUNT_AGE_YEARS` | Minimum Steam account age to pass |
| `MIN_FRIEND_COUNT` | Minimum Steam friend count to pass |
| `KICK_ON_COUNTRY_MISMATCH` | If true, fail when Steam-registered country ≠ IP-geolocated country |
| `API_CACHE_MINUTES` | How long a passed check is cached per SteamID before re-checking |
| `FIRST_KICK_DELAY_SECONDS` / `SECOND_KICK_DELAY_SECONDS` | Delay from join time to each scheduled kick |
| `KICK_THRESHOLD` | Kicks within a rolling 1-hour window before a SteamID is banned outright |
| `KICK_ON_PASS` | If true, kick everyone regardless of outcome (useful for dry-run testing of the pipeline) |
| `KICK_MESSAGE_FAIL` / `KICK_MESSAGE_PASS` | Text appended to the RCON kick reason |

There's no live-reload — restart the process after changing these.

## Audit logs

Both services write daily, date-stamped logs to their own `audit/` folder (`audit/<service>-YYYY-MM-DD.log`, created automatically on first run). These logs contain real player data — usernames, SteamIDs, IPs — so they're git-ignored and should be treated as sensitive; don't share them outside of your own server admin team.

## Repo layout

```
pz-connection-guard/
├── steamchecker/     Express API: Steam profile + IP lookups, whitelist
└── steviewonder/     Log tailer + RCON enforcer
```
