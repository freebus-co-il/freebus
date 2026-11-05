import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { I18nManager, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { render, screen } from '@/test-utils/render';

import { useSideInsets } from './safe-area';

// iPhone Duo folded, held upright: its system bars run down the left side
// (84pt), and there is nothing on the right.
const DUO_METRICS = {
  frame: { x: 0, y: 0, width: 466, height: 678 },
  insets: { top: 0, bottom: 20, left: 84, right: 0 },
};

function Probe() {
  const { start, end } = useSideInsets();
  return <Text>{`start ${start} end ${end}`}</Text>;
}

describe('useSideInsets', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('puts the left inset at the start in a left-to-right layout', async () => {
    jest.replaceProperty(I18nManager, 'isRTL', false);
    await render(<SafeAreaProvider initialMetrics={DUO_METRICS}><Probe /></SafeAreaProvider>);
    expect(screen.getByText('start 84 end 0')).toBeTruthy();
  });

  test('puts the left inset at the end in Hebrew, where the line starts on the right', async () => {
    jest.replaceProperty(I18nManager, 'isRTL', true);
    await render(<SafeAreaProvider initialMetrics={DUO_METRICS}><Probe /></SafeAreaProvider>);
    expect(screen.getByText('start 0 end 84')).toBeTruthy();
  });
});
