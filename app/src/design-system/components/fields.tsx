import { forwardRef } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';

import { INPUT_ALIGN_START } from '@/i18n/direction';

import { useColors } from '../theme';
import { Opacity, Radius, Size, Space, Type } from '../tokens';

import { Glass, GLASS_TARGET_CLIP } from './glass';
import { Icon } from './icon';
import { IconButton } from './icon-button';
import { Text } from './text';

export type SearchFieldProps = Omit<TextInputProps, 'style'> & {
  /** Shows a clear button while there is text. */
  onClear?: () => void;
  clearLabel?: string;
  /** Trailing content inside the field (a map button). */
  trailing?: React.ReactNode;
  /** Liquid Glass instead of the control fill: for a field that is the
   *  screen's chrome (a search bar beside a back button). */
  glass?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** An editable search capsule. Body text, leading magnifier, optional clear. */
export const SearchField = forwardRef<TextInput, SearchFieldProps>(function SearchField(
  { onClear, clearLabel, trailing, glass = false, style, value, ...input },
  ref,
) {
  const colors = useColors();
  const Shell = glass ? GlassShell : View;
  return (
    <Shell
      style={[
        styles.field,
        glass ? styles.glassField : { backgroundColor: colors.controlFill, borderColor: colors.controlEdge },
        style,
      ]}
    >
      {/* The glass field is Home's "Where to?" capsule arrived on the search
          screen: the same glyph and inset, so the morph between the two lands
          without a jump. */}
      <Icon name="search" size="md" color={glass ? 'textPrimary' : 'textSecondary'} weight={glass ? 'medium' : 'regular'} />
      <TextInput
        ref={ref}
        value={value}
        placeholderTextColor={colors.textSecondary}
        selectionColor={colors.accent}
        style={[styles.input, { color: colors.textPrimary }, Platform.OS === 'web' && styles.webNoOutline]}
        returnKeyType="search"
        {...input}
      />
      {onClear && !!value && (
        <IconButton icon="close" accessibilityLabel={clearLabel ?? 'Clear'} onPress={onClear} variant="plain" size="sm" color="textSecondary" />
      )}
      {trailing}
    </Shell>
  );
});

function GlassShell({ style, children }: { style: StyleProp<ViewStyle>; children: React.ReactNode }) {
  return (
    <Glass shape="capsule" style={style}>
      {children}
    </Glass>
  );
}

/**
 * A page's search bar: the back button and the field side by side, the way a
 * search screen reads on iOS 26 -- one row of glass at the top of the page.
 */
export const SearchHeader = forwardRef<TextInput, SearchFieldProps & {
  onBack: () => void;
  backLabel: string;
  /** Style for the field's slot. */
  fieldStyle?: StyleProp<ViewStyle>;
  /** Holds the slot empty (a morph is standing in for the field). The field
   *  mounts when this turns off -- never hidden with opacity, which stops
   *  Liquid Glass from rendering for good. */
  fieldHidden?: boolean;
  /** Style for the back button (faded in alongside a morph); may be animated. */
  backStyle?: React.ComponentProps<typeof Animated.View>['style'];
  /** The field's slot, for measuring where it sits. */
  fieldSlotRef?: React.Ref<View>;
  /** Fired when the field's slot is laid out (and so can be measured). */
  onFieldLayout?: () => void;
}>(function SearchHeader({ onBack, backLabel, fieldStyle, fieldHidden = false, backStyle, fieldSlotRef, onFieldLayout, style, ...field }, ref) {
  return (
    <View style={[styles.header, style]}>
      <Animated.View style={backStyle}>
        <IconButton icon="chevronBack" accessibilityLabel={backLabel} onPress={onBack} variant="glass" />
      </Animated.View>
      <View ref={fieldSlotRef} collapsable={false} onLayout={onFieldLayout} style={[styles.grow, fieldStyle]}>
        {fieldHidden ? <View style={styles.fieldPlaceholder} /> : <SearchField ref={ref} glass {...field} />}
      </View>
    </View>
  );
});

/**
 * The search field as a button: Home's "Where to?". Glass on iOS 26, because
 * it floats at the top of the page as the screen's main control.
 */
export const SearchButton = forwardRef<View, { label: string; onPress: () => void; accessibilityHint?: string; style?: StyleProp<ViewStyle> }>(function SearchButton(
  { label, onPress, accessibilityHint, style },
  ref,
) {
  return (
    <Pressable
      ref={ref}
      accessibilityRole="search"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => [styles.grow, styles.pill, GLASS_TARGET_CLIP, pressed && Platform.OS !== 'ios' && { opacity: Opacity.pressed }, style]}
    >
      <Glass interactive shape="capsule" style={styles.button}>
        <Icon name="search" size="md" weight="medium" />
        <Text variant="body" color="textSecondary" numberOfLines={1} style={styles.grow}>
          {label}
        </Text>
      </Glass>
    </Pressable>
  );
});

export type TextFieldProps = Omit<TextInputProps, 'style'> & { label?: string; style?: StyleProp<ViewStyle> };

/** A single-line text input on a nested surface. */
export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField({ label, style, ...input }, ref) {
  const colors = useColors();
  return (
    <View style={[styles.textFieldWrap, style]}>
      {label && (
        <Text variant="subheadline" emphasized color="textSecondary">
          {label}
        </Text>
      )}
      <TextInput
        ref={ref}
        placeholderTextColor={colors.textSecondary}
        selectionColor={colors.accent}
        style={[
          styles.textField,
          { color: colors.textPrimary, backgroundColor: colors.controlFill, borderColor: colors.controlEdge },
          Platform.OS === 'web' && styles.webNoOutline,
        ]}
        {...input}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    height: Size.control.md,
    paddingStart: Space.md,
    paddingEnd: Space.xs,
    borderRadius: Radius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    fontSize: Type.body.fontSize,
    fontWeight: Type.body.fontWeight,
    textAlign: INPUT_ALIGN_START,
    height: Size.control.md,
    padding: 0,
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  webNoOutline: { outlineWidth: 0 } as object,
  grow: { flex: 1 },
  glassField: { borderWidth: 0, paddingStart: Space.lg },
  fieldPlaceholder: { height: Size.control.md },
  header: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  // Android draws its focus highlight on the press target: give it the pill's
  // shape (clipped there only -- iOS 26's glass grows past it under a touch).
  pill: { borderRadius: Radius.full },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    height: Size.control.md,
    paddingHorizontal: Space.lg,
  },
  textFieldWrap: { gap: Space.sm },
  textField: {
    height: Size.control.md,
    paddingHorizontal: Space.md,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: Type.body.fontSize,
    textAlign: INPUT_ALIGN_START,
  },
});
