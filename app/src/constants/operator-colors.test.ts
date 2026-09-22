import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OPERATOR_COLORS, OPERATOR_FALLBACK_RING, SHARED_COLOR_GROUPS, operatorColor,
} from './operator-colors';

/** sRGB channel -> linear light, per WCAG's relative-luminance definition. */
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Best WCAG contrast this background can reach against black OR white text --
 *  the pills pick whichever is more legible, so either passing is enough. */
function bestTextContrast(hex: string): number {
  const l = relativeLuminance(hex);
  return Math.max((l + 0.05) / 0.05, 1.05 / (l + 0.05));
}

/** CIE76 dE between two sRGB hex colours, via XYZ (D65) and CIELAB. */
function deltaE(a: string, b: string): number {
  const lab = (hex: string): [number, number, number] => {
    const [r, g, bl] = rgb(hex).map(linear) as [number, number, number];
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    const z = (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

const ALL = [...Object.values(OPERATOR_COLORS), ...OPERATOR_FALLBACK_RING];

/**
 * How far apart two operators must stay. CIE76 puts the just-noticeable
 * difference near 2.3, so 20 is not a subtle margin -- it is the distance at
 * which two colours stay separable at the sizes these are actually drawn at,
 * a 3mm pill and a 4px polyline, glanced at rather than compared. It is also
 * as far apart as fifteen operators can be pushed while each stays
 * recognisably its own brand: Israeli transit brands cluster on navy and
 * orange, and the blue band is the binding constraint.
 */
const MIN_DELTA_E = 20;

test('every colour is a full 6-digit hex', () => {
  for (const c of ALL) assert.match(c, /^#[0-9a-f]{6}$/i, `${c} is not a 6-digit hex`);
});

test('every colour is legible under black or white text', () => {
  for (const c of ALL) {
    assert.ok(
      bestTextContrast(c) >= 4.5,
      `${c} reaches only ${bestTextContrast(c).toFixed(2)}:1 against its best text colour`,
    );
  }
});

/** True when two agency ids are declared to be the same company. */
function sameCompany(idA: string, idB: string): boolean {
  return SHARED_COLOR_GROUPS.some((g) => g.includes(idA) && g.includes(idB));
}

test('no two operators are confusable', () => {
  const entries = Object.entries(OPERATOR_COLORS);
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [idA, a] = entries[i]!;
      const [idB, b] = entries[j]!;
      if (sameCompany(idA, idB)) continue;
      assert.ok(
        deltaE(a, b) >= MIN_DELTA_E,
        `agency ${idA} (${a}) and ${idB} (${b}) differ by only dE ${deltaE(a, b).toFixed(1)}`,
      );
    }
  }
});

test('the only operators sharing a colour are the declared same-company ones', () => {
  const entries = Object.entries(OPERATOR_COLORS);
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [idA, a] = entries[i]!;
      const [idB, b] = entries[j]!;
      if (a !== b) continue;
      assert.ok(
        sameCompany(idA, idB),
        `agency ${idA} and ${idB} both use ${a} but are not declared the same company`,
      );
    }
  }
});

test('every id in a shared-colour group actually has that colour', () => {
  for (const group of SHARED_COLOR_GROUPS) {
    for (const id of group) {
      assert.ok(OPERATOR_COLORS[id] !== undefined, `agency ${id} is in a group but has no colour`);
    }
    const colors = new Set(group.map((id) => OPERATOR_COLORS[id]));
    assert.equal(colors.size, 1, `group ${group.join('+')} does not share one colour`);
  }
});

test('the generated ring stays clear of the hand-picked colours', () => {
  for (const ringColor of OPERATOR_FALLBACK_RING) {
    for (const [id, picked] of Object.entries(OPERATOR_COLORS)) {
      assert.ok(
        deltaE(ringColor, picked) >= MIN_DELTA_E,
        `ring colour ${ringColor} collides with agency ${id} (${picked})`,
      );
    }
  }
});

test('the generated ring does not collide with itself', () => {
  for (let i = 0; i < OPERATOR_FALLBACK_RING.length; i += 1) {
    for (let j = i + 1; j < OPERATOR_FALLBACK_RING.length; j += 1) {
      const a = OPERATOR_FALLBACK_RING[i]!;
      const b = OPERATOR_FALLBACK_RING[j]!;
      assert.ok(
        deltaE(a, b) >= MIN_DELTA_E,
        `ring colours ${a} and ${b} differ by only dE ${deltaE(a, b).toFixed(1)}`,
      );
    }
  }
});

test('a known operator gets its brand colour', () => {
  assert.equal(operatorColor('3'), OPERATOR_COLORS['3']);
  assert.equal(operatorColor('2'), OPERATOR_COLORS['2']);
});

test('an unknown operator gets a colour from the ring', () => {
  const color = operatorColor('99999');
  assert.ok(color !== null);
  assert.ok(OPERATOR_FALLBACK_RING.includes(color), `${color} is not a ring colour`);
});

test('an unknown operator gets the SAME colour every time', () => {
  assert.equal(operatorColor('99999'), operatorColor('99999'));
  assert.equal(operatorColor('40'), operatorColor('40'));
});

test('different unknown operators generally get different colours', () => {
  // Every agency in the feed that has no hand-picked colour, so a regression
  // that collapsed the hash would be caught here rather than on a map.
  const unknown = ['6', '7', '8', '10', '20', '21', '22', '23', '24', '33',
    '39', '40', '42', '44', '45', '49', '50', '51', '91', '97'];
  const distinct = new Set(unknown.map(operatorColor));
  assert.ok(
    distinct.size >= OPERATOR_FALLBACK_RING.length - 4,
    `${unknown.length} agencies collapsed onto only ${distinct.size} colours`,
  );
});

test('an agency the feed left blank gets no colour', () => {
  assert.equal(operatorColor(null), null);
});
