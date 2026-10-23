import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Opacity, Radius, Size, Space } from '../tokens';
import { Glass } from './glass';
import { Icon, type IconName } from './icon';
import { Text } from './text';

export type ToastProps = {
  icon?: IconName;
  message: string;
  detail?: string;
  onPress?: () => void;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
};

/** A floating glass notice. The caller positions it (above the tab bar). */
export function Toast({ icon, message, detail, onPress, accessibilityHint, style }: ToastProps) {
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => [pressed && { opacity: Opacity.pressed }, style]}
    >
      <Glass interactive={!!onPress} shape="rounded" style={styles.toast}>
        <View style={styles.row}>
          {icon && <Icon name={icon} size="md" />}
          <View style={styles.text}>
            <Text variant="subheadline" emphasized numberOfLines={1}>
              {message}
            </Text>
            {detail && (
              <Text variant="footnote" color="textSecondary" numberOfLines={2}>
                {detail}
              </Text>
            )}
          </View>
        </View>
      </Glass>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  toast: { borderRadius: Radius.xl, minHeight: Size.control.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingHorizontal: Space.lg, paddingVertical: Space.md },
  text: { flex: 1, gap: Space.xxs },
});
