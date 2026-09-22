import type Database from "better-sqlite3";

export const LANGS = ["he", "en", "ar"] as const;
export type Lang = (typeof LANGS)[number];

/** The feed stores language codes uppercase: HE, EN, AR. */
function feedCode(lang: Lang): string {
  return lang.toUpperCase();
}

export function parseLang(raw: string | undefined): Lang {
  if (raw === undefined || raw === "") return "he";
  const lower = raw.toLowerCase();
  if ((LANGS as readonly string[]).includes(lower)) return lower as Lang;
  throw new Error(`Unsupported lang: ${raw}`);
}

/**
 * `translations` is the legacy three-column form: it joins on the literal
 * name text, not on a record id. So the lookup key is the raw feed string.
 *
 * The whole table (102,386 rows, ~10 MB) is loaded once. A correlated
 * subquery per row of every response would be far more expensive, and the
 * table is rebuilt only when the feed version changes.
 */
export class Translator {
  private constructor(private readonly byLang: Map<string, Map<string, string>>) {}

  static load(db: Database.Database): Translator {
    const byLang = new Map<string, Map<string, string>>();
    for (const lang of LANGS) byLang.set(feedCode(lang), new Map());

    const rows = db.prepare(
      "SELECT trans_id, lang, translation FROM translations WHERE translation IS NOT NULL",
    ).iterate() as Iterable<{ trans_id: string; lang: string; translation: string }>;

    for (const row of rows) {
      byLang.get(row.lang.toUpperCase())?.set(row.trans_id, row.translation);
    }
    return new Translator(byLang);
  }

  /**
   * Returns the translation, or the raw feed text when none exists. Never
   * returns null for a non-null input: 7.6% of stop names are untranslated
   * and a blank name is worse than a Hebrew one.
   */
  resolve(raw: string | null, lang: Lang): string | null {
    if (raw === null) return null;
    return this.byLang.get(feedCode(lang))?.get(raw) ?? raw;
  }

  /**
   * Feed names whose translation in `lang` contains `query`, case-insensitively.
   *
   * This is what makes cross-language search work at all: `stops_fts` indexes
   * only the Hebrew feed text, so an English query would otherwise match
   * nothing. Scanning ~33k translated names in memory takes under a
   * millisecond — cheaper than maintaining a second FTS index per language.
   */
  namesMatching(query: string, lang: Lang, limit: number): string[] {
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    const out: string[] = [];
    const table = this.byLang.get(feedCode(lang));
    if (table === undefined) return out;
    for (const [transId, translation] of table) {
      if (translation.toLowerCase().includes(needle)) {
        out.push(transId);
        if (out.length >= limit) break;
      }
    }
    return out;
  }
}
