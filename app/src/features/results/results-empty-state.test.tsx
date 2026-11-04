import { describe, expect, jest, test } from '@jest/globals';

import { fireEvent, render, screen } from '@/test-utils/render';

import { ResultsEmptyState } from './results-empty-state';

const props = {
  title: 'No trips found',
  body: 'Try a later time.',
  actionLabel: 'Search again',
};

describe('ResultsEmptyState', () => {
  test('says why there is nothing, and offers the action', async () => {
    const onAction = jest.fn();
    await render(<ResultsEmptyState {...props} onAction={onAction} />);

    expect(screen.getByText('No trips found')).toBeTruthy();
    expect(screen.getByText('Try a later time.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Search again' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  // A refresh already in flight: the button shows it and cannot be pressed
  // again.
  test('disables the action while it is busy', async () => {
    const onAction = jest.fn();
    await render(<ResultsEmptyState {...props} onAction={onAction} busy />);

    const button = screen.getByRole('button');
    expect(button.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
    await fireEvent.press(button);
    expect(onAction).not.toHaveBeenCalled();
  });
});
