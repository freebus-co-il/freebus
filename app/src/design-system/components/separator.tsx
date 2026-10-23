import { View } from 'react-native';

import { useColors } from '../theme';
import { Border } from '../tokens';

/**
 * The line between two rows in one group. `insetStart` keeps it clear of the
 * rows' leading slot, the iOS convention; 0 spans the full width.
 */
export function Separator({ insetStart = 0, insetEnd = 0 }: { insetStart?: number; insetEnd?: number }) {
  const colors = useColors();
  return (
    <View
      style={{ height: Border.hairline, backgroundColor: colors.separator, marginStart: insetStart, marginEnd: insetEnd }}
    />
  );
}
