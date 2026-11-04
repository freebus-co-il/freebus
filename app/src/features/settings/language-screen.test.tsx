import { describe, expect, test } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { fireEvent, renderRouter, screen } from '@/test-utils/render';

// Kept out of src/app: every file there becomes a route.
import LanguageSettingsScreen from '@/app/settings/language';

const LANGUAGES = ['Device default', 'עברית', 'English', 'العربية', 'Русский', 'Español'];

function selected(name: string): boolean | undefined {
  return screen.getByRole('radio', { name }).props.accessibilityState?.selected;
}

async function open() {
  await renderRouter({ 'settings/language': LanguageSettingsScreen }, '/settings/language');
}

describe('Language settings screen', () => {
  test('lists every language, starting on the device default', async () => {
    await open();

    for (const name of LANGUAGES) expect(screen.getByRole('radio', { name })).toBeTruthy();
    expect(selected('Device default')).toBe(true);
  });

  test('choosing a language selects it, switches to it and stores it', async () => {
    await open();

    await fireEvent.press(screen.getByRole('radio', { name: 'Español' }));

    expect(selected('Español')).toBe(true);
    // The page itself is now in Spanish: "Device default" has been translated.
    expect(selected('Idioma del dispositivo')).toBe(false);
    expect(screen.queryByText('Device default')).toBeNull();
    const values = await Promise.all((await AsyncStorage.getAllKeys()).map((key) => AsyncStorage.getItem(key)));
    expect(values.some((value) => value?.includes('"language":"es"'))).toBe(true);
  });
});
