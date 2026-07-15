# Railway cost consolidation — prepared 2026-07-15, NOT deployed

Prepared alongside the V2 frontend work. Nothing here is live; deploy when ready.

## Why

8 containers run 24/7 (web-gateway, websocket-gateway, clients, cards, decks,
rooms, games, + transporter/Redis) for a game whose traffic a single node
process handles trivially. Moleculer treats process boundaries as transparent —
one broker running every service turns network calls into in-memory calls.

**Bonus correctness fix:** `games-service` keeps its round timers in process
memory (`setGameTimeout`). If it ever runs with >1 replica, each replica keeps
its own timer chain and rounds double-advance (observed while testing V2 on
2026-07-15: turn transitions fired far faster than the coded 10s/15s delays —
check the Railway replica count for games-service). Single-process = single
timer chain, bug gone.

## What's prepared

- `services/mono-service/` — runs clients + cards + decks + rooms + games +
  web-gateway on ONE broker. See the header of `index.js` for details.
- `scripts/cleanup-stale-data.js` — daily cron for leaked anon clients and
  dead rooms (the public lobby currently lists locked rooms from months ago).

## Target topology (8 → 2 containers)

| Railway service | Runs | Public domain |
|---|---|---|
| `api-mono` | mono-service (everything except websockets) | api.cardsagainstformality.io |
| `ws-gateway` | websocket-gateway-service (unchanged) | socket.cardsagainstformality.io |

Keep `TRANSPORTER_URI` set on both — the two processes still need the broker
transport to reach each other. Redis cacher stays optional (mono falls back to
in-memory when `REDIS_HOST` is unset, but the ws-gateway split means a shared
cache is still safer for `clients.*` reads — measure before dropping it).

## Deploy steps

1. `npx lerna run build` (mono requires each package's `build/` output).
2. New Railway service `api-mono`: root `services/mono-service`,
   start `npm start`, env = union of the merged services' env vars
   (MONGO_URI, firebase creds, PORT, TRANSPORTER_URI, optional REDIS_*).
3. Point the api domain at it; watch logs; kill the 6 old services.
4. Add a cron for `scripts/cleanup-stale-data.js` (start with `--dry-run`).

## Possible later step (2 → 1 container)

Attach socket.io to the web-gateway's HTTP server (moleculer-web exposes it)
so both share one port/domain — then the transporter and the second service
disappear entirely. Code change in websocket-gateway-service; not prepared.

## Frontend cost work already done in V2 (2026-07-15)

- `/api/decks` traffic eliminated — deck list ships as static `public/decks.json`
  (regenerate if decks ever change: see `V2_MIGRATION_HANDOFF.md`).
- Route-level code splitting: initial JS 452 KB → 192 KB.
- `preconnect` hints for api/socket/firebase origins.
