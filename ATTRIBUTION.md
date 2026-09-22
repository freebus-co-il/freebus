# Attribution

This repository's own code is licensed MIT (see `LICENSE`). That licence
covers the code only. The data this project consumes at runtime comes from
third parties under their own terms, described below. Deploying or
distributing this project means also meeting those terms — they are not
satisfied by the MIT licence on the code.

## OpenStreetMap data (ODbL 1.0)

Three parts of this stack are built from OpenStreetMap data and are therefore
subject to the [Open Database Licence (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/),
which requires the attribution "© OpenStreetMap contributors" wherever the
data (or a produced work substantially derived from it) is shown.

**The first is committed to this repository. The other two are built at deploy
time and never enter the tree.**

- **The baked rail geometry, `api/assets/rail-geometry.json`.** The GTFS feed
  ships no shapes for rail, so `api/src/rail/bakeMain.ts` queries Overpass for
  the track geometry between station pairs and bakes it into this file
  (`npm --prefix api run bake:rail`). It is a Derivative Database under ODbL
  and is the only OpenStreetMap-derived data file distributed in this
  repository. It carries its own `attribution` and `osmTimestamp` fields, so
  the notice travels with the data rather than depending on this document.
- **Valhalla's routing tiles.** `docker-compose.yml` builds the `valhalla`
  service's tiles from
  `tile_urls=https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf`
  — Geofabrik's Israel-and-Palestine extract of OpenStreetMap, rebuilt into
  Valhalla's own tile format on first container start.
- **Photon's geocoding index.** `api/photon/entrypoint.sh` builds Photon's
  search index from Photon's own official Asia-continent OSM jsonl dump,
  filtered at import time to country codes `IL,PS`. This is still
  OpenStreetMap data, redistributed by the Photon project in a different
  file format, not an independently sourced address database.

**What this obliges a deployer to do:** any output derived from these — the
routes Valhalla returns, the addresses and places Photon geocodes, and the
rail lines drawn from the baked geometry — must carry the attribution
"© OpenStreetMap contributors" wherever it reaches an end user.
**This currently appears nowhere in the app's user interface.** That is an
open compliance gap, not a design choice: this document is the
repository-level notice, and it does not discharge the obligation for a
shipped app. It is tracked as a follow-up in `README.md`'s roadmap.

## Israel Ministry of Transport GTFS feed

The `gtfs` service (`gtfs/README.md`, `gtfs/src/config.ts`) fetches the
national public transit schedule feed from:

```
https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip
```

This is Israel's Ministry of Transport and Road Safety (המשרד לתחבורה
ולבטיחות בדרכים) GTFS feed, published at `gtfs.mot.gov.il`. It is fetched
directly by URL — the repository has no licence file, terms-of-use document,
or usage-terms reference for this feed anywhere in its source, tests, or
documentation.

**Could not be established from this repository:** the feed's licence or
terms of use. Nothing in `gtfs/`, `docs/`, or elsewhere in the codebase
states what MOT permits (attribution requirements, redistribution rights,
commercial-use terms, or a disclaimer of accuracy). **The maintainer must
confirm the current terms of use published at `gtfs.mot.gov.il` (or Israel's
open-data portal, `data.gov.il`, if the feed is also listed there) before
this project is published, and update this section with the actual terms** —
do not assume public-domain or unrestricted status in the absence of that
confirmation.

## Third-party services (containerised, not vendored)

These run as separate containers per `docker-compose.yml` and are not
modified or redistributed as source by this repository — only invoked over
HTTP:

- **[Valhalla](https://github.com/valhalla/valhalla)** — routing engine.
  Licensed [MIT](https://github.com/valhalla/valhalla/blob/master/LICENSE.md).
  Run from the prebuilt image `ghcr.io/gis-ops/docker-valhalla/valhalla:latest`.
- **[Photon](https://github.com/komoot/photon)** — geocoder, by komoot.
  Licensed [Apache License 2.0](https://github.com/komoot/photon/blob/master/LICENSE).
  Run from a custom image built in `api/photon/Dockerfile`, which downloads
  the official `photon-1.3.0.jar` release from the Photon project and adds an
  entrypoint script (`api/photon/entrypoint.sh`) to build the index described
  above; the Photon jar itself is unmodified.

## Summary

| Component | Source | Licence | Attribution required |
| --- | --- | --- | --- |
| This repository's code | — | MIT | Copyright notice (see `LICENSE`) |
| `api/assets/rail-geometry.json` (committed) | OpenStreetMap via Overpass | ODbL 1.0 | "© OpenStreetMap contributors" — carried in the file's own `attribution` field |
| Valhalla routing tiles | Geofabrik `israel-and-palestine-latest.osm.pbf` (OpenStreetMap) | ODbL 1.0 | "© OpenStreetMap contributors" |
| Photon geocoding index | Photon's Asia-continent OSM jsonl dump | ODbL 1.0 | "© OpenStreetMap contributors" |
| GTFS schedule data | `gtfs.mot.gov.il` (Israel Ministry of Transport) | **Unconfirmed — see above** | **Unconfirmed — see above** |
| Valhalla (engine) | `ghcr.io/gis-ops/docker-valhalla/valhalla` | MIT | Licence file retained upstream |
| Photon (engine) | `github.com/komoot/photon`, release 1.3.0 | Apache-2.0 | Licence file retained upstream |
