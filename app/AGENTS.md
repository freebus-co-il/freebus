# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# RTL and LTR

The app runs Hebrew (RTL) and English (LTR), on a phone set to either language. Write every
screen once, in start/end terms, and let React Native mirror it:

- Direction is decided in ONE place: `src/i18n/direction.ts` (`applyLayoutDirection`, called by the
  preferences provider). It pins both `allowRTL` and `forceRTL` to the app language and restarts
  when the running layout disagrees. Never call `I18nManager.forceRTL`/`allowRTL` anywhere else, and
  never set expo-localization's `supportsRTL`/`forcesRTL` in app.json -- on iOS that rewrites the
  flag from the DEVICE language on every launch.
- `flexDirection: 'row'` already runs right-to-left in Hebrew. Never pick `row-reverse` by language.
- Use `marginStart`/`marginEnd`, `paddingStart`/`paddingEnd`, `start`/`end`, `borderStartWidth`.
  Physical `left`/`right` are only for things that are physical (a point on a map) or symmetric.
- Text alignment: the design system's `Text` already starts text at the line's start. For a
  `<TextInput>` use `INPUT_ALIGN_START`. Never `isRTL ? 'right' : 'left'` --
  React Native already treats `left` as start on `<Text>`, so that mirrors twice.
- Arrows and chevrons are the design system's directional icons (`chevronForward`, `chevronBack`,
  `arrowForward`, `arrowBack`), never a `scaleX: -1` flip.
- A lint rule (`eslint.config.js`) enforces the above; check new screens in both languages.

# Design system

Everything visual comes from `src/design-system` (import from `@/design-system`). The spec,
including why each choice was made, is `docs/private/design-system/design-system.md`.

- Content is solid, chrome is glass. Lists, cards and departures sit on solid surfaces; the
  tab bar, headers, toolbars, floating buttons and map controls are Liquid Glass on iOS 26
  (`Glass`, `GlassGroup`, native tabs and headers) and tonal surfaces on Android and older iOS.
  Never glass on glass, never glass on content.
- Pages are `bgGrouped` with grouped inset lists: `ListSection` + `ListRow`. Rows never draw
  their own separators; long catalogues use `variant="plain"` with `dense` rows.
- Colours only from `useColors()` roles, type only from `<Text variant>`, icons only from
  `<Icon name>` (SF Symbols on iOS, Material Symbols on Android), and spacing, radius, size,
  border, opacity and motion only from tokens. The lint config enforces this outside
  `src/design-system`.
- Pushed, non-map screens use `<NativeHeader>`; map screens keep a full-bleed map with glass
  controls.
- No shadows anywhere: depth comes from materials.

# Haptics

Every haptic goes through `src/lib/haptics.ts`, whose functions are named for what just
happened (`hapticGestureRecognised`, `hapticSettled`, `hapticSelected`, `hapticSucceeded`,
`hapticWarned`) rather than for the waveform. Never import `expo-haptics` at a call site --
the vocabulary is what lets the whole app be re-tuned from one file.

Add one only for a moment with NO immediate visual, or one the rider may not be looking at:
a long press before its sheet appears, the map pin landing, a selection changing, the
get-off alarm. Ordinary taps -- a chip, a row, a result, a tab -- answer themselves on
screen, and an app where everything buzzes is one where nothing means anything. For a
toggle, fire only on a real change: re-picking the option already chosen is a no-op, and
buzzing there teaches that the tap means nothing.

`alertSettings.vibrate` gates exactly ONE of them, the get-off alert, because that switch is
the rider's answer about the alarm and not about interface feedback. iOS already honours the
system-level haptics setting, so there is no app-level one.

Every call is fire-and-forget and swallows its error: a device with no Taptic Engine, or a
binary without the native module, must fall through to the action itself in silence.
`expo-haptics` is NATIVE -- adding or changing it needs a new EAS build and cannot ship over
the air.
