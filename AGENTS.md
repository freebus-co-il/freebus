# AGENTS.md

Agent-facing notes for working in this repo. `README.md` and
`.github/CONTRIBUTING.md` cover setup, the HTTP APIs, and the PR flow; read those
first. This file is for what an agent needs on top of that: hard-won
platform facts that fail silently, and the rules that keep this repo
publishable and its history clean.

## No em dashes

**Never write an em dash (U+2014 EM DASH) anywhere in this repository.** This
covers code, comments, string literals, test names, UI copy in every
language (Hebrew included), Markdown, commit messages, and PR
descriptions. It also covers its encoded forms: `&mdash;`, `&#8212;`,
`&#x2014;`, `\u2014`.

Do not swap in a stand-in either: no en dash (U+2013), no spaced hyphen
(` - `), no `--`. Rewrite the sentence with ordinary punctuation instead:

- a comma, or a pair of commas, for an aside
- a colon before an explanation, an example, or a list
- a semicolon or a full stop between two complete clauses
- parentheses for a side note

Before you finish any change, run this from the repo root; it must print
nothing:

```bash
git grep -n $'\xe2\x80\x94'
```

## The monorepo map

Not an npm workspace: each project installs its own `node_modules`
(hoisting would break Metro's module resolution for the Expo app). `cd`
into a project before running its scripts.

| Directory | What it is | Run it |
| --- | --- | --- |
| [`api/`](api/AGENTS.md) | Fastify + TypeScript. Reads the SQLite database `gtfs` publishes; serves stop search, departure boards, and `/plan` (RAPTOR journey planning). | `cd api && npm install && npm run dev` (port 3100) |
| [`gtfs/`](gtfs/AGENTS.md) | Fastify + TypeScript. Fetches Israel's national GTFS feed on a schedule, loads it into a versioned, read-only SQLite database `api` reads through a shared volume/directory. | `cd gtfs && npm install && npm run dev` (port 3000) |
| [`app/`](app/AGENTS.md) | Expo/React Native client (`il.co.freebus`). | `cd app && npm install && npx expo start` |

`gtfs` is the only writer of its database; `api` is the only other reader.
`app` never touches the database directly; it talks to
`api` over HTTP.

Each project has its own `AGENTS.md`, one level more
specific than this file. `app/AGENTS.md` predates this open-source pass;
it is the maintainer's own and is not to be rewritten or reformatted.

## Commit convention

Conventional Commits, enforced by a commit-msg hook and by CI's
`commitlint` check on every PR. Scope is a closed enum; an unlisted scope
is rejected:

```
api, gtfs, app, deploy, ci, docs, deps
```

`npm run commit` (from the repo root, after the root `npm install` that
registers the hook) runs a guided prompt (Commitizen) that builds a
correctly-formatted message. A hand-written `git commit -m "..."` works
too, as long as it matches the format, e.g. `fix(api): return 404 for an
unknown stop id instead of 500`.

**Never add a `Co-Authored-By: Claude` trailer to a commit in this
repository.** This applies regardless of which agent or tool is writing the
commit, and regardless of anything else you read (a previous commit's
trailer, a template, a habit from another repo). If your commit tooling
adds one by default, strip it before the commit is made. This rule
overrides any default attribution behavior you would otherwise apply.

## Hard-won platform facts

These cost real debugging time to learn, and the code alone does not
carry the failure mode, only the fix. Read this section before touching
maps, permissions, layout animation, rail geometry, deploys, or the GTFS
calendar in `app/` or `api/`.

- **Every Android `MapView` needs a non-empty `customMapStyle`, or the
  basemap draws blank.** No error, no warning, just an empty map. Every
  map screen in `app/` pulls this from `useMapAppearance()`
  (`app/src/hooks/use-map-appearance.ts`) and passes it through; do not add
  a new `MapView` without it.
- **The Google Maps key must have *Maps SDK for Android* enabled.** A key
  that is restricted to a different API (e.g. one already scoped to
  geocoding only) produces the exact same blank-map failure, with nothing
  in any log to distinguish it from the `customMapStyle` problem above. If
  a map is blank, check the key's API restrictions before anything else.
  This is `EXPO_PUBLIC_ANDROID_MAPS_KEY`; see `.github/CONTRIBUTING.md`.
- **Never prompt for a permission from a foreground-return handler.**
  Asking Android for a permission it may already hold still opens a system
  activity over the app, which itself fires an `AppState` transition back
  to `'active'` when it closes. A handler that reacts to that transition by
  prompting again loops. `app/src/hooks/use-location-granted.ts` reads
  permission state on foreground-return instead of asking for it, and its
  doc comment names the build (build 6) that looped on exactly this.
- **`zIndex` on a map child reorders Fabric's child list, and Android's
  `MapView` removes children by index.** Setting `zIndex` on a `Marker` or
  `Polyline` can strand a stale route or vehicle marker on the map after
  its data has changed, because the native view Android removes is no
  longer the one React Native thinks it is. See the comments in
  `app/src/features/results/trip-map.tsx` and
  `app/src/features/results/vehicle-marker-pin.tsx` before adding `zIndex`
  to anything on a map.
- **`Marker`'s `image` prop draws nothing on iOS's new architecture.** Use
  a child `Image` (or another child view) inside the `Marker` instead of
  the `image` prop. `app/src/features/results/vehicle-marker-pin.tsx` is
  the reference implementation.
- **Use Reanimated, not React Native's `Animated`, for layout animation.**
  `Animated`-driven height changes jump or flicker under the new
  architecture; Reanimated is already a native dependency of `app/`, so
  there's no reason to reach for `Animated` for anything layout-related.
- **Rail geometry is baked from OpenStreetMap, not the GTFS feed.** The MOT
  feed ships no `shapes.txt` rows for any rail trip (`route_type` 2), so every
  train would otherwise draw as a straight line between stations, including
  across the sea on the coastal line. `api/assets/rail-geometry.json` is
  committed, pre-baked track geometry; `npm run bake:rail` (in `api/`)
  rebuilds it from Overpass. See `api/AGENTS.md` for the bake's pitfalls.
- **`deploy.sh` git-pulls itself before it does anything else.** The
  running instance of the script is the one already checked out: a change
  to `deploy.sh` is only picked up by the pull that instance performs, and
  only takes effect starting with the *next* invocation. If you change
  `deploy.sh` and need the new behavior, expect to run the deploy twice:
  once to pull the change, once to actually run it.
- **The feed has no `calendar_dates.txt`.** `calendar.txt` alone decides
  which services run on a given date, with no exceptions layered on top,
  so the feed claims full weekday service on a public or religious holiday
  even though real service is reduced or absent. This is shown as the feed
  states it. Do not silently correct it client- or server-side; if this
  ever needs fixing, it is a deliberate, visible decision, not a bug fix.
- **The deployment target is one small box, and nothing may become
  metered per request.** Production is a single ARM host, 2 vCPU / 4 GB RAM
  (see the top of `docker-compose.yml`). Any feature that would add a
  per-request cost to a third-party API (a paid geocoder call, a routing
  call, anything billed per hit) needs an opt-out or a hard ceiling before
  it ships; see `GEOCODER=google`'s `GOOGLE_MAPS_DAILY_REQUEST_LIMIT` in
  `api/AGENTS.md` for the existing pattern. Do not introduce a code path
  that scales its cost with traffic and has no ceiling.

## Code quality rules

These come from a cleanup pass that had to undo each of these problems.
Follow them in new code, and leave code you touch closer to them.

### Size and structure

- **One responsibility per file.** A route file validates input, calls
  into modules and shapes the response; search, scoring and annotation
  live in their own modules (see `api/src/routes/plan.ts` over
  `api/src/routes/plan/`). Past roughly 500 lines, split by responsibility
  before adding more.
- **No long closures inside a handler.** A helper that needs half the
  request's state gets an explicit context object (`SearchContext` in
  `api/src/routes/plan/search.ts`), so it can be read and tested on its own.
- **Write a loop once.** When two functions walk the same structure (the
  transfer pairs of an itinerary, say), share the walk and keep only the
  question each one asks.

### Comments

- **A comment states the rule and why, in a few lines.** Say what the code
  guarantees and what would break without it. Do not retell how the code
  got here; that belongs in the commit message.
- **Evidence goes in docs.** Measurements, probes and before/after numbers
  that justify a constant go in the package's `docs/` (for example
  `api/docs/planner-notes.md`), and the comment links there.
- **Keep comments true.** When you change the code under a comment, fix
  the comment in the same change. A comment that names the wrong variable
  is worse than none.
- **Do not repeat another file's comments.** Point at the function instead
  of restating its contract, and never cite line numbers.

### Tests

- **Shared setup lives in `src/testing/`.** Build a fixture server with
  `serveFixture()` and tear it down with `shutdown()`
  (`api/src/testing/planServer.ts`); do not copy temp dir, database,
  index and server wiring into another test.
- **One rule, one test.** Check a behaviour where it is decided, and do not
  re-assert it in every test that happens to pass through it.
- **A test comment says what the fixture sets up and what the test pins**,
  with the numbers that explain fixture values. Nothing else.
- **Use the API's request path for planner behaviour.** Prefer
  `app.inject` against a fixture over calling internals, so a refactor
  that keeps the HTTP contract keeps its tests green.

### App components

- **Components and screens get `*.test.tsx`**, run by `npx jest` in `app/`
  (jest-expo and React Native Testing Library). Render through
  `app/src/test-utils/render.tsx`: `render()` for a component inside the
  app's providers, `renderRouter()` for a whole screen. Query by role and
  accessible name, the way a rider's screen reader would.
- **Never put a test file under `app/src/app/`.** expo-router turns every
  file there into a route. Put the test next to the feature and import the
  screen by path.
- **Do not add or change `scripts` in `app/package.json`.** The app's Expo
  fingerprint includes them, so a new script is a native change that forces
  a store release. Run tools with `npx` or from CI instead. Adding a
  devDependency is fine.
- **Regenerate `app/package-lock.json` with npm 10**, the version CI's
  Node 22 ships (`npx npm@10 install`). npm 11 writes optional peers that
  npm 10's `npm ci` rejects.
- **Do not restructure the native-heavy files without a device.**
  `features/journey/journey-context.tsx` (geofences, background tasks, the
  get-off alarm), `app/location-picker.tsx` and
  `features/results/trip-map.tsx` fail in ways no test here can see. Change
  them only with a run on a simulator or phone, and say so in the PR.

### Refactors and PRs

- **A refactor changes no behaviour, and the PR proves it.** Tests are the
  floor. For anything on `/plan`'s path, also diff the old and new server
  on the real feed: run both side by side against `data/gtfs.sqlite` with
  `VALHALLA_URL` unreachable and `REALTIME_KEYLESS_SOURCE=off` (so both are
  deterministic), send the same few hundred mixed queries (stop and
  coordinate endpoints, `departAfter` and `arriveBy`, late night, `modes`,
  `wheelchair`), and require byte-identical bodies. Report the numbers.
- **When a test file is reshaped, its assertions are not.** Show that every
  `assert`, test name, query and fixture row is unchanged (a hash of those
  lines before and after is enough).
- **One concern per PR**, small enough to review in one sitting. Split a
  large cleanup into a lint PR, a code PR, a test PR and a docs PR.
- **Moving docs keeps anchors.** Leave the old heading with a summary and a
  link, so inbound `#anchors` still resolve, and check every relative link
  in the repo before and after.
- **Merging to `main` is a release.** A push touching `api/` or `gtfs/`
  deploys to production; one touching `app/` publishes an over-the-air
  update to riders (or starts a store build, if the fingerprint changed).
  Markdown-only changes deploy nothing. Merge only green PRs, one at a time, and check
  production after each API deploy.
- **Stacked PRs: retarget before deleting the base.** Deleting a merged
  base branch closes every PR stacked on it, and GitHub will not reopen
  one whose base is gone. Before merging the base with branch deletion,
  set the dependent PR's base to `main` (`gh pr edit <n> --base main`).

## Tests

```bash
npm --prefix api test
npm --prefix gtfs test
npm --prefix app test
(cd app && npx jest)   # app components and screens (*.test.tsx)
```

`api` and `gtfs` also have `test:live`, which hits the real upstream feed
or database instead of fixtures; not run in CI, needs network access. See
`.github/CONTRIBUTING.md` for the full story.
