import type { WalkManeuver } from '@/api/types';

/** The translation key for each move, under `journey.nav`. */
const KEYS: Record<WalkManeuver, string> = {
  depart: 'depart',
  arrive: 'arrive',
  straight: 'straight',
  'slight-right': 'slightRight',
  right: 'right',
  'sharp-right': 'sharpRight',
  'slight-left': 'slightLeft',
  left: 'left',
  'sharp-left': 'sharpLeft',
  uturn: 'uturn',
  roundabout: 'roundabout',
  stairs: 'stairs',
  elevator: 'elevator',
  escalator: 'escalator',
  'enter-building': 'enterBuilding',
  'exit-building': 'exitBuilding',
  ferry: 'ferry',
};

/** Moves worth naming the street they lead onto. Stairs and lifts lead onto
 *  whatever the map calls the walkway, which says nothing. */
const NAMES_STREET = new Set<WalkManeuver>([
  'depart', 'straight', 'slight-right', 'right', 'sharp-right', 'slight-left', 'left', 'sharp-left', 'roundabout',
]);

const STARTS_HEBREW = /^[\u0590-\u05FF]/;

/**
 * A name as it follows Hebrew's attached "ל" ("to"): as is when it starts with a
 * Hebrew letter ("להדקלים"), after a hyphen when it does not ("ל-652", "ל-HaYarkon")
 * -- the way Hebrew writes a prefix onto a number or a foreign word, and what keeps
 * the right-to-left text from reordering the prefix past the number.
 */
function afterHebrewPrefix(name: string, language: string): string {
  return language.startsWith('he') && !STARTS_HEBREW.test(name) ? `-${name}` : name;
}

/**
 * The phrase for a move, as a translation key and its values: "Turn right onto
 * {{street}}" when the move has a named street, "Turn right" when not, and --
 * for arriving -- the place being arrived at, when the walk leads to one.
 */
export function walkInstruction(
  move: { maneuver: WalkManeuver; street: string | null },
  arrivingAt: string | null,
  language = 'en',
): { key: string; values: Record<string, string> } {
  if (move.maneuver === 'arrive') {
    return arrivingAt
      ? { key: 'journey.nav.arriveAt', values: { name: afterHebrewPrefix(arrivingAt, language) } }
      : { key: 'journey.nav.arrive', values: {} };
  }
  const key = `journey.nav.${KEYS[move.maneuver]}`;
  return move.street && NAMES_STREET.has(move.maneuver)
    ? { key: `${key}Onto`, values: { street: afterHebrewPrefix(move.street, language) } }
    : { key, values: {} };
}
