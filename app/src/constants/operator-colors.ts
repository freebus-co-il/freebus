/**
 * A colour per operating company, so a rider can tell at a glance who runs the
 * bus in front of them.
 *
 * This exists because the feed's own `route_color` is NOT a brand colour. The
 * ministry publishes only four values (`FF9933`, `33CC33`, `9933FF`,
 * `3399FF`) and they encode a SERVICE CLASS, not a company: the same four
 * recur across Egged, Dan, Kavim and everyone else alike, 82% of routes carry
 * none at all, and rail carries none ever. Colouring by `route_color`
 * therefore says nothing a rider can act on, which is why every surface here
 * resolves an operator colour instead (see `lib/route-color`).
 *
 * ## Where the colours come from
 *
 * Each value below is anchored to a colour taken from the operator's own site
 * or published brand assets, then moved as far as it had to be moved for no
 * two operators to look alike. Fidelity had to give a little: Israeli transit
 * brands cluster hard on navy blue (Israel Railways, Kavim, Superbus and Dan
 * are all blue) and on orange (Metropoline and Nateev Express are within a
 * hair of the same hue). Rendered literally, half the network would read as
 * one company on a 3mm pill or a 4px polyline. The anchor sets the hue family;
 * lightness carries the separation.
 *
 * `operator-colors.test.ts` is the enforcement: every pair must stay at least
 * dE 20 apart, and every colour must reach 4.5:1 against black or white text.
 * Change a value and the test tells you what it broke.
 */

/**
 * Hand-picked colours, keyed by GTFS `agency_id`. Covers the 15 operators that
 * run 92% of the network's routes; everyone else draws from
 * `OPERATOR_FALLBACK_RING`.
 *
 * Sub-brands sit in their parent's hue family on purpose -- Dan and Dan
 * BaDarom being two shades of the same blue is the true relationship, not a
 * collision.
 */
export const OPERATOR_COLORS: Record<string, string> = {
  /** רכבת ישראל (Israel Railways) -- its published indigo, used verbatim. */
  '2': '#1e1f56',
  /** אגד (Egged) -- the green from egged.co.il. */
  '3': '#00875a',
  /** דרך אגד עוטף ירושלים -- an Egged sub-brand, so Egged's green lightened. */
  '135': '#8ad6b6',
  /** קווים (Kavim) -- its navy, brightened clear of the Railways indigo. */
  '18': '#1d4ed8',
  /** סופרבוס (Superbus) -- its site runs a green-to-navy gradient; this is
   *  that gradient's midpoint, which also clears both Egged and the blues. */
  '16': '#0d9488',
  /** דן (Dan) -- its blue, opened up to the light blue of the Dan livery. */
  '5': '#38bdf8',
  /** דן בדרום -- Dan family, one step deeper. */
  '31': '#0369a1',
  /** דן באר שבע -- Dan family, deepest. */
  '32': '#082f49',
  /** מטרופולין (Metropoline) -- its orange, used verbatim. */
  '15': '#ff8b00',
  /** נתיב אקספרס (Nateev Express) -- its orange, deepened to clear
   *  Metropoline's, which is otherwise the same hue. */
  '14': '#b45309',
  /** בית שמש אקספרס -- Nateev's sibling brand, and grey in Nateev's own
   *  navigation, so it keeps the grey rather than a second orange. */
  '35': '#64748b',
  /** אלקטרה אפיקים (Electra Afikim) -- its lime, used verbatim. */
  '25': '#9aca3c',
  /** אלקטרה אפיקים תחבורה -- Electra family, darkened to an olive. */
  '4': '#4d6b13',
  /** תנופה (Tnufa) -- the deep teal its site is built on. */
  '34': '#134e4a',
  /** אקסטרה and אקסטרה ירושלים -- ONE company that the feed splits into two
   *  agency ids (same name, same site), so both take the same blue rather
   *  than reading as rivals. From extrapt.co.il, moved off Kavim's blue. */
  '37': '#3b82f6',
  '38': '#3b82f6',
};

/**
 * Agency ids that SHARE a colour because the feed splits one company across
 * them. Everything else must stay visually distinct; `operator-colors.test.ts`
 * treats any other repeated colour as a mistake.
 *
 * Not the same thing as a sub-brand: דן בדרום really is its own operator with
 * its own name and fleet, so it gets its own shade of the Dan blue. אקסטרה and
 * אקסטרה ירושלים are the same operator wearing one name.
 */
export const SHARED_COLOR_GROUPS: readonly (readonly string[])[] = [
  ['37', '38'],
];

/**
 * Colours for operators with no hand-picked entry -- the 20 small ones
 * (regional councils, the Jerusalem-area union lines, Carmelit, taxi lines)
 * whose brand colour could not be established. None runs more than 144 routes.
 *
 * Deliberately drawn from the hue ranges the hand-picked colours leave empty
 * (violet, magenta, rose, brown, gold), so a generated colour never reads as
 * one of the researched fifteen. Twenty operators over twelve colours means
 * some do repeat -- acceptable only because they are the smallest in the feed
 * and rarely share a region. When a real brand colour turns up for one of
 * them, it moves into `OPERATOR_COLORS` and stops being generated.
 */
export const OPERATOR_FALLBACK_RING: readonly string[] = [
  '#7c3aed', // violet
  '#be185d', // rose
  '#c026d3', // fuchsia
  '#e11d48', // crimson
  '#4c1d95', // deep violet
  '#f472b6', // pink
  '#78350f', // umber
  '#701a75', // plum
  '#fb7185', // salmon
  '#facc15', // gold
  '#831843', // wine
  '#b91c1c', // brick
];

/** Stable, order-independent hash of an agency id (FNV-1a, 32-bit). */
function hashAgencyId(agencyId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < agencyId.length; i += 1) {
    h ^= agencyId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The colour for one operator: its hand-picked brand colour, or a stable
 * generated one. `null` only when the feed itself gives the route no agency,
 * which is the one case a caller must fall back to a neutral for.
 */
export function operatorColor(agencyId: string | null): string | null {
  if (agencyId === null || agencyId === '') return null;
  return OPERATOR_COLORS[agencyId]
    ?? OPERATOR_FALLBACK_RING[hashAgencyId(agencyId) % OPERATOR_FALLBACK_RING.length]!;
}
