/**
 * Exact per-faction counts, for one zone at a time.
 *
 * All 9.88M events, cut by zone rather than by date, so settling the pointer on
 * a dot fetches one ~35 KB block instead of the lot. Nothing on the map needs
 * them — the display stream draws every frame — so none of this is on the load
 * path.
 *
 * Rows carry absolute counts, not deltas, and run `(idx, observed_at)`. A day
 * with no row keeps the previous day's counts.
 */

import { decodeColumns, fetchBytes, type ColumnSpec, type Columns } from "./format";
import type { HistorySeries } from "./series";

export interface ZoneHistoryMeta {
  path: string;
  block_size: number;
  columns: ColumnSpec[];
  /** [block, rows, bytes] */
  blocks: [number, number, number][];
  bytes: number;
}

export interface ZoneCounts {
  faction: number;
  legion: number;
  swarm: number;
  faceless: number;
  total: number;
}

const blocks = new Map<number, Promise<Columns>>();

export function blockOf(meta: ZoneHistoryMeta, idx: number): number {
  return Math.floor(idx / meta.block_size);
}

/**
 * Fetch the block holding `idx`, or return what is already in hand.
 *
 * Returns null rather than a promise when the block is not loaded and
 * `only` is set, so a hover can render instantly from what it has and let the
 * fetch settle behind it.
 */
export function zoneBlock(
  base: string,
  meta: ZoneHistoryMeta,
  idx: number,
): Promise<Columns> | null {
  const block = blockOf(meta, idx);
  const existing = blocks.get(block);
  if (existing) return existing;

  const entry = meta.blocks.find(([id]) => id === block);
  if (!entry) return null; // a block of pure terrain has no history file

  const promise = fetchBytes(
    `${base}/${meta.path}/${String(block).padStart(4, "0")}.bin.br`,
  ).then((buffer) => decodeColumns(buffer, meta.columns, entry[1]));
  blocks.set(block, promise);
  return promise;
}

export function loadedBlock(meta: ZoneHistoryMeta, idx: number): Promise<Columns> | undefined {
  return blocks.get(blockOf(meta, idx));
}

/** Row range for one zone in a block ordered by idx. */
function rangeFor(columns: Columns, idx: number): [number, number] {
  const { idx: key } = columns;
  let low = 0;
  let high = key.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (key[mid] < idx) low = mid + 1;
    else high = mid;
  }
  let end = low;
  while (end < key.length && key[end] === idx) end++;
  return [low, end];
}

export function zoneCountsAt(columns: Columns, idx: number, day: number): ZoneCounts | null {
  const [start, end] = rangeFor(columns, idx);
  if (start === end) return null;

  const { day: rowDay, control_state, legion_count, swarm_count, faceless_count } = columns;
  let found = -1;
  for (let i = start; i < end; i++) if (rowDay[i] <= day) found = i;
  if (found < 0) return { faction: 0, legion: 0, swarm: 0, faceless: 0, total: 0 };

  const legion = legion_count[found];
  const swarm = swarm_count[found];
  const faceless = faceless_count[found];
  return {
    faction: control_state[found],
    legion,
    swarm,
    faceless,
    total: legion + swarm + faceless,
  };
}

/** One zone's exact trajectory, carried forward across days with no event. */
export function zoneSeries(columns: Columns, idx: number, maxDay: number): HistorySeries {
  const span = maxDay + 1;
  const days = new Int32Array(span);
  const legion = new Float64Array(span);
  const swarm = new Float64Array(span);
  const faceless = new Float64Array(span);

  const [start, end] = rangeFor(columns, idx);
  const { day, legion_count, swarm_count, faceless_count } = columns;

  let row = start;
  let l = 0;
  let s = 0;
  let f = 0;
  for (let d = 0; d < span; d++) {
    while (row < end && day[row] <= d) {
      l = legion_count[row];
      s = swarm_count[row];
      f = faceless_count[row];
      row++;
    }
    days[d] = d;
    legion[d] = l;
    swarm[d] = s;
    faceless[d] = f;
  }
  return { days, legion, swarm, faceless };
}
