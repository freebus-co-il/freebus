import { beforeEach, expect, jest, test } from '@jest/globals';
import { Alert, Linking } from 'react-native';

import FeedbackScreen from '@/app/settings/feedback';
import { fireEvent, renderRouter, screen } from '@/test-utils/render';

beforeEach(() => {
  jest.restoreAllMocks();
});

test('opens feedback in the default mail app and provides contribution links', async () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  await renderRouter({ 'settings/feedback': FeedbackScreen }, '/settings/feedback');

  expect(screen.getByText(/nonprofit community project/)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: /Email us/ }));
  expect(openURL).toHaveBeenLastCalledWith('mailto:contactfreebus@gmail.com');
  await fireEvent.press(screen.getByRole('button', { name: 'View repository' }));
  expect(openURL).toHaveBeenLastCalledWith('https://github.com/freebus-co-il/freebus');
  await fireEvent.press(screen.getByRole('button', { name: 'Contribution guide' }));
  expect(openURL).toHaveBeenLastCalledWith('https://github.com/freebus-co-il/freebus/blob/main/.github/CONTRIBUTING.md');
});

test('shows contact details when the mail app cannot be opened', async () => {
  jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('No mail app'));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await renderRouter({ 'settings/feedback': FeedbackScreen }, '/settings/feedback');

  await fireEvent.press(screen.getByRole('button', { name: /Email us/ }));
  expect(alert).toHaveBeenCalledWith('Could not open the link', expect.stringContaining('contactfreebus@gmail.com'));
});
