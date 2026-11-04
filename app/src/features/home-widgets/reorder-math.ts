/**
 * The geometry of dragging one row through a short column of rows of mixed
 * heights. Worklets, because the drag runs on the UI thread; plain functions
 * under node, where the directive is just a string, so they are tested there.
 *
 * Rows are laid out in their current order with no gaps; `heights[i]` is row
 * i's measured height.
 */

/** Where row `index` starts. */
export function offsetOf(heights: readonly number[], index: number): number {
  'worklet';
  let offset = 0;
  for (let i = 0; i < index; i += 1) offset += heights[i] ?? 0;
  return offset;
}

/** The drag kept inside the column: the row can go to either end, not past it. */
export function clampDrag(heights: readonly number[], from: number, dy: number): number {
  'worklet';
  const start = offsetOf(heights, from);
  const total = offsetOf(heights, heights.length);
  const min = 0 - start;
  const max = total - start - (heights[from] ?? 0);
  return Math.min(max, Math.max(min, dy));
}

/**
 * The index the dragged row would land at, against the rows where they sit:
 * going down, it has passed a row once its bottom edge is below that row's
 * middle; going up, once its top edge is above it. Measuring by edges rather
 * than middles is what keeps a tall row from swapping with a short neighbour
 * before it has moved at all.
 */
export function targetIndex(heights: readonly number[], from: number, dy: number): number {
  'worklet';
  const top = offsetOf(heights, from) + dy;
  const bottom = top + (heights[from] ?? 0);
  let to = from;
  for (let i = 0; i < heights.length; i += 1) {
    const middle = offsetOf(heights, i) + (heights[i] ?? 0) / 2;
    if (i > from && bottom > middle) to += 1;
    if (i < from && top < middle) to -= 1;
  }
  return to;
}

/** How far the dragged row moves from where it started to sit in slot `to`. */
export function slotDrag(heights: readonly number[], from: number, to: number): number {
  'worklet';
  if (to > from) return offsetOf(heights, to + 1) - offsetOf(heights, from + 1);
  return offsetOf(heights, to) - offsetOf(heights, from);
}

/** How far row `index` steps aside while row `from` hovers over slot `to`:
 *  up by the dragged row's height when it is passed going down, down by it
 *  when passed going up, otherwise not at all. */
export function stepAside(heights: readonly number[], index: number, from: number, to: number): number {
  'worklet';
  const height = heights[from] ?? 0;
  if (from < index && index <= to) return -height;
  if (to <= index && index < from) return height;
  return 0;
}

/** The order once the row at `from` has been dropped at `to`. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return [...items];
  next.splice(to, 0, moved);
  return next;
}
