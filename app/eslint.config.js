// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  // The app runs both directions -- Hebrew RTL, English LTR -- so layout is
  // written in START/END terms and React Native mirrors it. See the RTL section
  // of AGENTS.md; `src/i18n/direction.ts` is the only place direction is decided.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Property[key.name=/^(margin|padding)(Left|Right)$/]",
          message: "Use the logical side (marginStart/marginEnd, paddingStart/paddingEnd) so the layout mirrors in Hebrew.",
        },
        {
          selector: "Property[key.name=/^border(Left|Right)(Width|Color)$/]",
          message: "Use borderStartWidth/borderEndWidth (and -Color) so the border mirrors in Hebrew.",
        },
        {
          selector: "ConditionalExpression[consequent.value=/^(left|right)$/][alternate.value=/^(left|right)$/]",
          message: "React Native already mirrors 'left'/'right' under RTL -- choosing between them by isRTL mirrors twice. Use TEXT_ALIGN_START / INPUT_ALIGN_START from '@/i18n/direction', or `start`/`end` for positions.",
        },
        {
          selector: "CallExpression[callee.object.name='I18nManager'][callee.property.name=/^(forceRTL|allowRTL)$/]",
          message: "Layout direction is decided only in src/i18n/direction.ts (applyLayoutDirection).",
        },
      ],
    },
  },
]);
