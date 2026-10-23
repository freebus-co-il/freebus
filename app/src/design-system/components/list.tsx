import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { hapticGestureRecognised } from '@/lib/haptics';

import { useColors } from '../theme';
import { Layout, Opacity, Radius, Size, Space } from '../tokens';
import { Icon } from './icon';
import { Separator } from './separator';
import { Text } from './text';

export type ListSectionProps = {
  title?: string;
  /** Trailing content in the header line (a "See all", a collapse chevron). */
  headerAccessory?: ReactNode;
  footer?: string;
  /** `grouped`: rows in a rounded group on the grouped page. `plain`: full-bleed
   *  rows on a plain page, for long catalogues. */
  variant?: 'grouped' | 'plain';
  /** Where row separators start, measured from the row's start edge. By
   *  default a separator clears the leading slot of the row under it when that
   *  row has one, and starts at the row's text inset when it doesn't. */
  separatorInsetStart?: number;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * A list section: header, a group of rows with separators between them (never
 * above the first or below the last), and an optional footer. Separators are
 * inserted here -- rows never draw their own. See design-system.md 5.4.
 */
export function ListSection({
  title,
  headerAccessory,
  footer,
  variant = 'grouped',
  separatorInsetStart,
  children,
  style,
}: ListSectionProps) {
  const colors = useColors();
  const rows = Children.toArray(children).filter(isValidElement);
  const grouped = variant === 'grouped';
  return (
    <View style={style}>
      {(title || headerAccessory) && (
        <View style={styles.header}>
          {title && (
            <Text variant="subheadline" emphasized color="textSecondary" accessibilityRole="header" style={styles.headerText}>
              {title}
            </Text>
          )}
          {headerAccessory}
        </View>
      )}
      {rows.length > 0 && (
        <View
          style={
            grouped
              ? [styles.group, { backgroundColor: colors.surfaceGroup }]
              : null
          }
        >
          {rows.map((row, index) => (
            <Fragment key={row.key ?? index}>
              {index > 0 && <Separator insetStart={separatorInsetStart ?? insetFor(row)} />}
              {row}
            </Fragment>
          ))}
        </View>
      )}
      {footer && (
        <Text variant="footnote" color="textSecondary" style={styles.footer}>
          {footer}
        </Text>
      )}
    </View>
  );
}

/** A row with a leading slot starts its text after it; one without starts at
 *  the row inset. The separator above a row starts where its text does. */
function insetFor(row: ReactElement): number {
  const props = row.props as { leading?: ReactNode } | null;
  return props?.leading ? Layout.rowPaddingH + Size.leadingTile + Space.md : Layout.rowPaddingH;
}

export type ListRowProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  /** An icon tile, line badge, station sign, status dot. */
  leading?: ReactNode;
  /** A value, time, switch, button. Shown before the accessory. */
  trailing?: ReactNode;
  accessory?: 'chevron' | 'check' | 'none';
  /** With accessory `check`: shows the mark. */
  selected?: boolean;
  /** With accessory `check`: `multiple` makes the row a checkbox (checked),
   *  `single` a radio (selected). */
  selection?: 'single' | 'multiple';
  destructive?: boolean;
  /** For a row that opens content under itself: reports expanded / collapsed. */
  expanded?: boolean;
  dense?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Lines of title before truncating. */
  titleLines?: number;
  style?: StyleProp<ViewStyle>;
};

/** One row. Lives inside a `ListSection`, which draws the group and separators. */
export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  accessory = 'none',
  selected = false,
  selection = 'single',
  destructive = false,
  expanded,
  dense = false,
  disabled = false,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityHint,
  titleLines = 2,
  style,
}: ListRowProps) {
  const colors = useColors();
  const body = (
    <>
      {leading && <View style={styles.leading}>{leading}</View>}
      <View style={styles.text}>
        {typeof title === 'string' ? (
          <Text variant="body" color={destructive ? 'danger' : 'textPrimary'} numberOfLines={titleLines}>
            {title}
          </Text>
        ) : (
          title
        )}
        {subtitle !== undefined &&
          (typeof subtitle === 'string' ? (
            <Text variant="subheadline" color="textSecondary" numberOfLines={2}>
              {subtitle}
            </Text>
          ) : (
            subtitle
          ))}
      </View>
      {trailing}
      {accessory === 'chevron' && <Icon name="chevronForward" size="sm" color="textTertiary" weight="semibold" />}
      {accessory === 'check' && (
        <View style={styles.check}>{selected && <Icon name="check" size="md" color="accent" weight="semibold" />}</View>
      )}
    </>
  );
  const rowStyle = [styles.row, { minHeight: dense ? Size.row.dense : Size.row.min }, disabled && { opacity: Opacity.disabled }, style];

  if (!onPress && !onLongPress) {
    return (
      <View style={rowStyle} accessible={accessibilityLabel !== undefined} accessibilityLabel={accessibilityLabel}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole={accessory === 'check' ? (selection === 'multiple' ? 'checkbox' : 'radio') : 'button'}
      accessibilityState={
        accessory === 'check'
          ? selection === 'multiple'
            ? { checked: selected, disabled }
            : { selected, disabled }
          : { disabled, expanded }
      }
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress && (() => {
        hapticGestureRecognised();
        onLongPress();
      })}
      android_ripple={{ color: colors.fillPressed }}
      style={({ pressed }) => [rowStyle, pressed && Platform.OS === 'ios' && { backgroundColor: colors.fillPressed }]}
    >
      {body}
    </Pressable>
  );
}

/**
 * A long, paged list (a search result) drawn as ONE grouped section while
 * staying a virtualised `FlatList`: each item paints its own slice of the
 * group -- inset from the page edge, rounded only at the group's first and
 * last rows. Spread into the row's `style`.
 */
export function useGroupedItemStyle(): (index: number, count: number) => StyleProp<ViewStyle> {
  const colors = useColors();
  return (index, count) => [
    { backgroundColor: colors.surfaceGroup, marginHorizontal: Layout.pageInset },
    index === 0 && { borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl },
    index === count - 1 && { borderBottomLeftRadius: Radius.xl, borderBottomRightRadius: Radius.xl },
  ];
}

/** The separator between two items of a `useGroupedItemStyle` list. */
export function GroupedItemSeparator({ leading = true }: { leading?: boolean }) {
  const colors = useColors();
  return (
    <View style={{ backgroundColor: colors.surfaceGroup, marginHorizontal: Layout.pageInset }}>
      <Separator insetStart={leading ? Layout.rowPaddingH + Size.leadingTile + Space.md : Layout.rowPaddingH} />
    </View>
  );
}

/** The rounded tile that holds a row's leading icon. */
export function LeadingIcon({ children, tone = 'nested' }: { children: ReactNode; tone?: 'nested' | 'accent' }) {
  const colors = useColors();
  return (
    <View style={[styles.tile, { backgroundColor: tone === 'accent' ? colors.accent : colors.surfaceNested }]}>{children}</View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingHorizontal: Layout.rowPaddingH,
    marginBottom: Layout.headerToGroup,
  },
  headerText: { flex: 1 },
  group: { borderRadius: Radius.xl, overflow: 'hidden' },
  footer: { paddingHorizontal: Layout.rowPaddingH, marginTop: Layout.groupFooterGap },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingVertical: Layout.rowPaddingV,
    paddingHorizontal: Layout.rowPaddingH,
  },
  leading: { minWidth: Size.leadingTile, alignItems: 'center' },
  text: { flex: 1, gap: Space.xxs },
  check: { width: Size.icon.md, alignItems: 'center' },
  tile: {
    width: Size.leadingTile,
    height: Size.leadingTile,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
