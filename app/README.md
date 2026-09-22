# FreeBus (פריבוס)

Native mobile client for the FreeBus public-transit product (freebus.co.il).
Expo + React Native + TypeScript, bundle/package id `il.co.freebus`.

The app currently ships the trip-planning flow: a Search screen
(origin/destination autocomplete against `/stops/search`, "use current
location" for origin) and a Results screen (`/plan`, itinerary cards, and a
map with decoded leg polylines). Both talk to the `api` service in
this repo.

## Get started

```bash
npm install
npx expo start
```

In the output, you'll find options to open the app in a development build,
Android emulator, iOS simulator, or Expo Go.

Routing is file-based via [Expo Router](https://docs.expo.dev/router/introduction)
under `src/app/`.

## Backend URL (`EXPO_PUBLIC_API_BASE_URL`)

`src/config/env.ts` reads `process.env.EXPO_PUBLIC_API_BASE_URL` and throws at
startup if it's unset, so the app never silently points at nothing. Expo
inlines any `EXPO_PUBLIC_*` variable at bundle time and loads the env file
matching the build mode:

| File               | Used by                                   | Current value              |
| ------------------ | ----------------------------------------- | -------------------------- |
| `.env.development` | `expo start` (dev server, default)        | `http://localhost:3100`    |
| `.env.production`  | `expo start --no-dev`, `expo export`, EAS | `https://api.freebus.co.il` |

To point at a different backend (a LAN IP so a physical device can reach your
laptop, or a staging box), edit the matching file — or create a
`.env.development.local` (gitignored) to override without touching the
committed default. Restart the dev server after any change: the value is
inlined at bundle time, not read at runtime.

Note that `http://localhost:3100` only resolves for the iOS simulator and web.
An Android emulator needs `http://10.0.2.2:3100`, and a physical device needs
your machine's LAN IP.

## Maps

`src/features/results/trip-map.tsx` and `trip-map.web.tsx` are **intentionally
two files, not a duplication to clean up.** `react-native-maps` doesn't
reliably bundle for web, so Metro's platform-extension resolution picks the
`.web.tsx` placeholder there and the native `MapView` implementation on iOS and
Android. Deleting or merging either one breaks the web bundle.

On Android the map renders blank until `EXPO_PUBLIC_ANDROID_MAPS_KEY` is set
in the environment (`app.config.js` reads it into
`android.config.googleMaps.apiKey`). It needs a Google Cloud credential.
iOS uses Apple Maps and needs no key.

## Language & RTL

Supported languages: Hebrew (`he`, default) and English (`en`), detected from
the device locale at startup (`src/i18n/index.ts`). Layout direction
(RTL/LTR) is derived from the resolved language via `I18nManager`. Note that
React Native only applies a new RTL/LTR value after a full app reload — an
in-app language switcher (not built yet) will need to trigger one.

User-facing strings live in `src/i18n/locales/{en,he}.json`; add every new
string to both. `src/lib/format.ts` reads the i18n singleton directly (rather
than a `t` from `useTranslation()`) because it's a plain helper module — safe
only as long as the language can't change without a reload.
