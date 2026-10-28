// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

// The app runs both directions -- Hebrew RTL, English LTR -- so layout is
// written in START/END terms and React Native mirrors it. See the RTL section
// of AGENTS.md; `src/i18n/direction.ts` is the only place direction is decided.
const rtlRules = [
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
];

// Everything visual goes through the design system (src/design-system,
// docs/private/design-system/design-system.md): no colours, type sizes, radii,
// border widths or shadows invented at a call site.
const designSystemRules = [
  {
    selector: "Property[key.name=/^(color|backgroundColor|borderColor|borderTopColor|borderBottomColor|borderStartColor|borderEndColor|tintColor|strokeColor|fillColor)$/] > Literal[value=/^(#|rgba?\\()/]",
    message: "Use a colour role from useColors() (design system), not a literal.",
  },
  {
    selector: "Property[key.name=/^(fontSize|lineHeight|fontWeight)$/] > Literal",
    message: "Use <Text variant> (design system) for type, not a hand-set size or weight.",
  },
  {
    selector: "Property[key.name=/^border(TopLeft|TopRight|BottomLeft|BottomRight|TopStart|TopEnd|BottomStart|BottomEnd)?Radius$/] > Literal[value>0]",
    message: "Use a Radius token (design system).",
  },
  {
    selector: "Property[key.name=/^border(Top|Bottom|Start|End)?Width$/] > Literal[value>0]",
    message: "Use a Border token (design system).",
  },
  {
    selector: "Property[key.name=/^(shadowColor|shadowOffset|shadowOpacity|shadowRadius|elevation|boxShadow)$/]",
    message: "No shadows: depth comes from materials (design system 3.10).",
  },
];

const legacyModules = [
  "@/components/themed-text",
  "@/components/themed-view",
  "@/components/hairline",
  "@/components/directional-icon",
  "@/components/segmented-control",
  "@/components/sheet-backdrop",
  "@/constants/theme",
  "@/hooks/use-theme",
  "@/features/search/field-shell",
];

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...rtlRules],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/design-system/**", "src/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...rtlRules, ...designSystemRules],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...legacyModules.map((name) => ({ name, message: "Retired: use the design system (@/design-system)." })),
            { name: "@tabler/icons-react-native", message: "Use <Icon name> from @/design-system." },
            { name: "expo-glass-effect", message: "Use <Glass> from @/design-system (it handles fallbacks)." },
            { name: "expo-symbols", message: "Use <Icon> from @/design-system." },
            { name: "@expo/ui/swift-ui", message: "Native SwiftUI controls are wrapped in @/design-system." },
            { name: "react-native", importNames: ["Text", "Modal"], message: "Use <Text> / <Sheet> from @/design-system." },
          ],
        },
      ],
    },
  },
]);
