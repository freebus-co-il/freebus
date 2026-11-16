import { forwardRef } from 'react';
import { View, type ViewInstance, type ViewProps } from 'react-native';

import { useColors } from '../theme';

export type SurfaceLevel = 'bgGrouped' | 'bgPlain' | 'surfaceGroup' | 'surfaceNested' | 'surfaceFloating';

/** A view painted with a page or surface role. No `level` paints nothing. */
export const Surface = forwardRef<ViewInstance, ViewProps & { level?: SurfaceLevel }>(function Surface({ level, style, ...rest }, ref) {
  const colors = useColors();
  return <View ref={ref} style={[level ? { backgroundColor: colors[level] } : null, style]} {...rest} />;
});
