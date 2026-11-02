import assert from 'node:assert/strict';
import { test } from 'node:test';

import ar from './locales/ar.json';
import en from './locales/en.json';
import es from './locales/es.json';
import he from './locales/he.json';
import ru from './locales/ru.json';

/**
 * English is the reference catalogue: every other language must say
 * everything it says, with the same placeholders. A key missing from one
 * language falls back to English mid-screen, which is exactly the stray
 * foreign string this test exists to catch.
 */
type Catalogue = { [key: string]: string | Catalogue };

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function flatten(catalogue: Catalogue, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(catalogue)) {
    if (typeof value === 'string') out.set(prefix + key, value);
    else for (const [k, v] of flatten(value, `${prefix}${key}.`)) out.set(k, v);
  }
  return out;
}

function baseKeys(flat: Map<string, string>): Set<string> {
  return new Set([...flat.keys()].map((key) => key.replace(PLURAL_SUFFIX, '')));
}

function pluralBases(flat: Map<string, string>): Set<string> {
  return new Set([...flat.keys()].filter((key) => PLURAL_SUFFIX.test(key)).map((key) => key.replace(PLURAL_SUFFIX, '')));
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/{{(\w+)}}/g)].map((match) => match[1]).sort();
}

const reference = flatten(en as Catalogue);

const CATALOGUES = { en, he, ar, ru, es } as const;

for (const [language, catalogue] of Object.entries(CATALOGUES)) {
  const flat = flatten(catalogue as Catalogue);

  if (language !== 'en') {
    test(`${language} has every key English has, and no others`, () => {
      assert.deepEqual([...baseKeys(flat)].sort(), [...baseKeys(reference)].sort());
    });

    test(`${language} keeps every placeholder of a non-plural string`, () => {
      for (const [key, text] of reference) {
        if (PLURAL_SUFFIX.test(key)) continue;
        assert.deepEqual(placeholders(flat.get(key) ?? ''), placeholders(text), key);
      }
    });
  }

  /**
   * Each language picks its own form for a count (Arabic six, Russian four,
   * Spanish three). A form left out does not fall back to another form of the
   * same language: i18next drops to the English string, so "3 stops" would
   * appear in English in the middle of a Russian screen.
   */
  test(`every ${language} plural has every form the language uses`, () => {
    const forms = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
    for (const base of pluralBases(flat)) {
      for (const form of forms) assert.ok(flat.has(`${base}_${form}`), `${base}_${form}`);
    }
  });
}
