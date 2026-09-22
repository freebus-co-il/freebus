const TIME_RE = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/;
const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;

export function parseGtfsTime(v: string): number | null {
  const m = TIME_RE.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function parseGtfsDate(v: string): number | null {
  const m = DATE_RE.exec(v.trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Number(m[1]) * 10000 + month * 100 + day;
}

export function parseInt0(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
}

export function parseFloat0(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function parseText(v: string): string | null {
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * The feed stores the geresh of a stop's one-letter suffix at the FRONT of the
 * name: "'אידר א" where the sign reads "אידר א'". Being logically first, it is
 * drawn at the start of the line by every bidi-correct renderer, on every
 * platform -- so it has to be fixed in the data, not in a client.
 *
 * Every such stop has exactly this shape (201 of 35,302 at the time of
 * writing): a name ending in a space and one Hebrew letter. Route long names
 * repeat it wherever such a stop opens either side of `origin<->destination`.
 *
 * Deliberately narrow: only a leading ASCII apostrophe in front of that shape
 * moves. Gershayim inside a name (ד''ר, בי''ס) stay byte-for-byte. `[^<>]`
 * keeps a match inside one side of a route long name.
 *
 * A few names are in translations.txt under BOTH spellings, so once fixed
 * they share a (trans_id, lang) key and the writer's INSERT OR REPLACE keeps
 * the later row. In the current feed that is always the correctly spelled
 * one, and the rows it replaces are alternative wordings of the same name
 * ("Primary School A" vs "Elementary School A"), not different places.
 */
const FLIPPED_NAME = /^'([^<>]* [א-ת])$/u;
const FLIPPED_ROUTE_SIDE = /(^|<->)'([^<>]*? [א-ת])(?=-)/gu;

export function fixFlippedGeresh(v: string): string {
  const name = FLIPPED_NAME.exec(v);
  if (name) return `${name[1]}'`;
  return v.replace(FLIPPED_ROUTE_SIDE, "$1$2'");
}

/**
 * `parseText`, then `fixFlippedGeresh`. For every column carrying feed name
 * text -- stop names, route long names, and `translations`, which is keyed by
 * that same text and must be normalized identically or lookups stop matching.
 */
export function parseName(v: string): string | null {
  const t = parseText(v);
  return t === null ? null : fixFlippedGeresh(t);
}
