# FreeBus (פריבוס)

FreeBus is an Israeli public-transit trip planner: search a stop or address,
get itineraries with walking and transfer legs, and see live delays where
the Ministry of Transport's realtime feed has data. It's a Fastify API in
front of a GTFS-derived database, a React Native/Expo app, and a couple of
supporting services for walking directions and address search.

## The projects

| Directory | What it is |
| --- | --- |
| [`api/`](api/README.md) | Fastify + TypeScript service. Reads the SQLite database `gtfs` publishes and serves stop search, departure boards, and multi-leg A→B journey planning (RAPTOR). |
| [`gtfs/`](gtfs/README.md) | Fastify + TypeScript service. Fetches Israel's national GTFS feed on a schedule and loads it into a versioned, read-only SQLite database that `api` reads. |
| [`app/`](app/README.md) | Expo + React Native client (`il.co.freebus`). Search + Results screens, backed by `api`. |

## Architecture

`gtfs` fetches the Israel Ministry of Transport's GTFS feed on a schedule and
builds it into a versioned SQLite database, atomically repointing a
`gtfs.sqlite` symlink at the new file when a build succeeds; a bad or
partial feed never goes live. `api` is the only other reader of that
database — it builds an in-memory RAPTOR journey-planning index from it and
serves stop search, departure boards, and `/plan`. For walking legs, `api`
calls a self-hosted **Valhalla** instance for real street-network routing
(falling back to a straight-line estimate if Valhalla is down or not
running). For address search, `api` calls either a self-hosted **Photon**
instance (free, OpenStreetMap-based) or the **Google Places/Geocoding API**
(metered, better coverage of businesses), switchable per deployment via
`GEOCODER=photon|google`; reverse geocoding always goes through Photon.
Live vehicle delays, when configured, come from the Ministry of Transport's
SIRI-SM feed or a keyless public snapshot and are annotated onto `/plan` and
the departure boards. The `app` client talks to `api` over HTTP.

`docker-compose.yml` at the repo root is how this runs in production: `api`,
`gtfs`, `valhalla`, `photon`, and a Caddy reverse proxy, all on one small
box. In development, each Node service (`api`, `gtfs`) normally runs from
source with `npm run dev`, and only Valhalla/Photon run in Docker — see
`api/README.md`'s [Setup](api/README.md#setup) section for that split.

## Quickstart

Each project manages its own dependencies — this repo is **not** an npm
workspace, because hoisting `node_modules` breaks Metro's module resolution
for the Expo app. Install and run each project separately.

Prerequisites: **Node.js 22+**, and **Docker** if you want real walking
directions or address search rather than the straight-line/no-results
fallback. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the rest of the setup,
including what the `app` project needs that the others don't.

**`api`** — the route-planning service:

```bash
cd api
npm install
cp .env.example .env
docker compose up -d valhalla photon   # optional; see api/README.md
npm run dev
```

**`gtfs`** — fetches the feed `api` reads (`api` needs *some* database to
serve from; run this at least once before `api`'s first launch, or point
`GTFS_DATA_DIR` at a database you already have):

```bash
cd gtfs
npm install
cp .env.example .env
npm run dev
```

**`app`** — the mobile client:

```bash
cd app
npm install
npx expo start
```

By default it points at `http://localhost:3100` (`api`'s dev port) — see
`app/README.md`'s [Backend URL](app/README.md#backend-url-expo_public_api_base_url)
section if you're running on a device or emulator that can't reach
`localhost` directly. **The Android build additionally needs your own
`EXPO_PUBLIC_ANDROID_MAPS_KEY`, or the map renders blank with no error** —
see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Tests

Each of `api`, `gtfs`, and `app` runs its own suite:

```bash
npm --prefix api test
npm --prefix gtfs test
npm --prefix app test
```

`api` and `gtfs` also have `test:live`, which hits the real upstream feed or
database instead of fixtures. It needs network access and is **not** run in
CI — see [`CONTRIBUTING.md`](CONTRIBUTING.md#tests).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full setup (including the
two things that will otherwise cost you an afternoon: the Android Maps key,
and the EAS project ownership), the commit convention, and the PR flow.

## License and attribution

This repository's code is [MIT licensed](LICENSE). It runs on data from
OpenStreetMap and Israel's Ministry of Transport under their own separate
terms — see [`ATTRIBUTION.md`](ATTRIBUTION.md) for what those require.

## Roadmap

- **Open OpenStreetMap attribution gap.** Both address search/geocoding
  (Photon) and walking directions (Valhalla) are built from OpenStreetMap
  data, which requires "© OpenStreetMap contributors" to be shown wherever
  that data reaches a user (ODbL 1.0). The app's UI does not currently show
  this attribution anywhere. See [`ATTRIBUTION.md`](ATTRIBUTION.md) for the
  full obligation — this needs to be added before the app is more broadly
  distributed.
