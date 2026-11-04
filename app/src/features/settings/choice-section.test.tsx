import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { hapticSelected } from '@/lib/haptics';
import { fireEvent, render, screen } from '@/test-utils/render';

import { ChoiceSection } from './choice-section';

jest.mock('@/lib/haptics', () => ({ hapticSelected: jest.fn() }));

const options = [
  { value: 'light' as const, labelKey: 'settings.themeLight' },
  { value: 'dark' as const, labelKey: 'settings.themeDark' },
];

describe('ChoiceSection', () => {
  beforeEach(() => {
    jest.mocked(hapticSelected).mockClear();
  });

  test('ticks the chosen option only', async () => {
    await render(<ChoiceSection options={options} value="dark" onChange={() => {}} />);

    const [light, dark] = screen.getAllByRole('radio');
    expect(light!.props.accessibilityState).toMatchObject({ selected: false });
    expect(dark!.props.accessibilityState).toMatchObject({ selected: true });
  });

  test('picking another option reports it, with a haptic', async () => {
    const onChange = jest.fn();
    await render(<ChoiceSection options={options} value="dark" onChange={onChange} />);

    await fireEvent.press(screen.getAllByRole('radio')[0]!);
    expect(onChange).toHaveBeenCalledWith('light');
    expect(hapticSelected).toHaveBeenCalledTimes(1);
  });

  // Re-picking the current option changes nothing, so it must not buzz
  // (app/AGENTS.md, Haptics).
  test('re-picking the chosen option does not buzz', async () => {
    const onChange = jest.fn();
    await render(<ChoiceSection options={options} value="dark" onChange={onChange} />);

    await fireEvent.press(screen.getAllByRole('radio')[1]!);
    expect(onChange).toHaveBeenCalledWith('dark');
    expect(hapticSelected).not.toHaveBeenCalled();
  });
});
