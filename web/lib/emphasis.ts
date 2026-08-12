/**
 * The five categories the panel names, as bits of one mask.
 *
 * A number rather than a set of booleans because it is part of `ZoneMap`'s
 * incremental repaint key: the fill loop skips every row whose bytes did not
 * move, so the key has to change when the emphasis does, and comparing one
 * integer is the whole of that.
 *
 * The faction bits are `1 << faction`, which is the arithmetic the fill loop
 * already does on `pk`, so the panel and the map cannot disagree about which bit
 * means which dot. An empty zone is grey whoever nominally holds it, so it
 * answers to `empty` rather than to a faction bit - and a zone never played in
 * fourteen years is terrain, drawn by its own layer, so it has a bit of its own.
 */
export const EMPHASIS = {
  empty: 1,
  legion: 1 << 1,
  swarm: 1 << 2,
  faceless: 1 << 3,
  neverPlayed: 1 << 4,
} as const;

export type EmphasisKey = keyof typeof EMPHASIS;

export const EMPHASIS_ALL =
  EMPHASIS.empty | EMPHASIS.legion | EMPHASIS.swarm | EMPHASIS.faceless | EMPHASIS.neverPlayed;

/**
 * Add or drop one category, and treat "everything" and "nothing" as the same
 * state - the map with one row lit and the map with all five lit are different
 * pictures, but a map with none lit answers no question at all.
 */
export function toggleEmphasis(current: number, key: EmphasisKey): number {
  const bit = EMPHASIS[key];
  // Starting from everything, the first click isolates rather than subtracting:
  // clicking Legion means "show me Legion", not "show me everything but Legion".
  const next = current === EMPHASIS_ALL ? bit : current ^ bit;
  return next === 0 ? EMPHASIS_ALL : next;
}
