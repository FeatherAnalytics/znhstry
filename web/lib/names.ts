/**
 * Zone names, fetched when the pointer stops on one.
 *
 * 12.6 MB across the whole world, in 655 blocks of about 19 KB. None of it is
 * on the load path: a visit that never hovers fetches none of it, which is the
 * point, since it would otherwise be nearly half of a cold load spent on a
 * readout most visits never ask for.
 *
 * Keyed by idx, not by tile: row `i` of block `B` is zone `B * block_size + i`,
 * and nothing about arrival order can change that. Sharding by tile would
 * instead require writing names in the tile's render order so each lines up
 * with the slot the client assigns as position files land — an invisible
 * invariant whose failure mode is a hover confidently naming the wrong place.
 */

import { loadJson } from "./format";

export interface NamesMeta {
  path: string;
  block_size: number;
  /** [block, rows, bytes] */
  blocks: [number, number, number][];
  bytes: number;
}

const blocks = new Map<number, Promise<string[]>>();

/**
 * Fetch the block holding `idx`, writing each name into `into` as it lands.
 *
 * Returns null when there is no such block, so a caller can render what it has
 * rather than waiting on a promise that will never resolve.
 */
export function loadNames(
  base: string,
  meta: NamesMeta,
  idx: number,
  into: string[],
): Promise<string[]> | null {
  const block = Math.floor(idx / meta.block_size);
  const existing = blocks.get(block);
  if (existing) return existing;
  if (!meta.blocks.some(([id]) => id === block)) return null;

  const promise = loadJson<string[]>(
    `${base}/${meta.path}/${String(block).padStart(4, "0")}.json.br`,
  ).then((names) => {
    const start = block * meta.block_size;
    for (let i = 0; i < names.length; i++) if (names[i]) into[start + i] = names[i];
    return names;
  });

  blocks.set(block, promise);
  return promise;
}
