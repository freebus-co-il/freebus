# Contributing to FreeBus

Thanks for the interest. This document covers the setup that isn't obvious
from the code, the commit and PR conventions, and how to run the tests.

## Prerequisites

- **Node.js 22+** (all three Node projects — `api`, `gtfs`, `app` — declare
  or require this).
- **Docker**, if you want `api` to have real walking directions (Valhalla)
  or self-hosted address search (Photon) instead of the straight-line/no-
  results fallback. Not required to run the tests.
- **An Expo setup**, for the `app` project: the [Expo Go](https://expo.dev/go)
  app on a physical device is the fastest way to get started; a native dev
  build additionally needs Xcode (iOS) or Android Studio (Android). See
  [Expo's docs](https://docs.expo.dev/get-started/set-up-your-environment/)
  if you're new to this.

## First-time setup

Install once at the repo root — this is **not** an npm workspace (hoisting
`node_modules` would break Metro's resolution for the Expo app), so this
install exists only to register the commit-message hook, not to pull in any
project's own dependencies:

```bash
npm install
```

Then install each project you're working on separately, e.g. `npm install`
inside `api/`, `gtfs/`, or `app/`. See the root [`README.md`](README.md) for
the full per-project quickstart.

## Commit convention

Commits follow [Conventional Commits](https://www.conventionalcommits.org/),
enforced by a commit-msg hook and, on every pull request, by CI. The scope is
restricted to what actually exists in this repo — an unlisted scope is
rejected:

```
api, gtfs, app, deploy, ci, docs, deps
```

Easiest way to write one:

```bash
npm run commit
```

This runs a guided prompt (Commitizen) that builds a correctly-formatted
message for you. Writing `git commit -m "..."` by hand works too, as long as
it matches the format, e.g.:

```
fix(api): return 404 for an unknown stop id instead of 500
```

The local hook only runs after you've done the root `npm install` above, and
it's bypassable with `--no-verify` — the real enforcement is the
`commitlint` GitHub Actions check, which runs against every commit in a PR.

## Branches and pull requests

- Branch off `main`. A short, descriptive branch name is enough — there's no
  enforced naming scheme, but something like `fix/plan-422-on-empty-modes` or
  `feat/app-language-switcher` helps reviewers guess the scope before opening
  it.
- Keep a PR to one logical change. Several unrelated fixes in one PR make it
  harder to review and to revert.
- Fill in the PR template: what changed and why, how you verified it, and
  the checklist.
- CI runs `typecheck`, `lint` (app only), and `test` for each project your
  PR touches, plus the commit-message check. All of it needs to pass before
  a merge.

## Tests

Run a project's suite with:

```bash
npm --prefix api test
npm --prefix gtfs test
npm --prefix app test
```

(or `cd` into the project and run `npm test`, equivalently).

`api` and `gtfs` also have `npm run test:live` (`npm --prefix api run
test:live`, etc.), which runs against the real upstream — the live GTFS feed
for `gtfs`, the live built database for `api` — instead of fixtures. It
needs network access and real upstream availability, so it is **not** run in
CI: a CI run that depends on a third party is a CI run that fails for
reasons a contributor can't fix. Run it locally if you're touching the code
paths it covers, but don't expect it to be green in an offline environment.

## The `app` project needs two things from you specifically

These are the two setup gaps that will otherwise cost you an afternoon of
silent failures before you find this section.

### 1. Your own `EXPO_PUBLIC_ANDROID_MAPS_KEY`

`app/app.config.js` reads `process.env.EXPO_PUBLIC_ANDROID_MAPS_KEY` into
the Android build's Google Maps API key. **Without it, the Android map
renders completely blank, with no error anywhere** — this is the single
most confusing failure in this app, by design of the underlying SDK, not a
bug you introduced.

You'll need a Google Cloud project with a Maps API key that has **Maps SDK
for Android** enabled. A key that's *restricted* to a different API — say,
one already scoped to geocoding only — produces the exact same silent blank
map, because the Android SDK's failure mode for "this key can't do what I
asked" is to draw nothing rather than surface an error. If your map is
blank, check the API restriction on the key before anything else.

Set the variable in your shell, or in an env file `expo start`/the Android
build picks up, before running `expo run:android` or building via EAS.

### 2. The EAS `projectId`/`owner` point at the maintainer's account

`app/app.config.js` hardcodes:

```js
extra: { eas: { projectId: "48516aee-b137-401c-83a2-122fbdb7578f" } },
owner: "sagishalom",
```

These identify the maintainer's Expo account and project. **`eas build` (or
`eas update`) will not work for you as-is** — you don't have access to that
project. To build with your own EAS account, either:

- run `eas init` in `app/` to create your own project (it will offer to
  update `projectId` for you), and change `owner` to your own Expo username
  or remove the field entirely, or
- edit `app.config.js` directly with your own `projectId`/`owner` before
  running any `eas` command.

None of this is needed just to run the app locally via `expo start` or
`expo run:android`/`expo run:ios` — it only matters once you try to use EAS
Build or EAS Update.

## Code of conduct

Participation in this project is covered by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Reporting a security issue

Please don't open a public issue — see [`SECURITY.md`](SECURITY.md) for how
to report it privately.
