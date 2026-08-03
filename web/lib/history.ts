/**
 * Time series, at three grains.
 *
 * Whole-scope and viewport series come from pre-aggregated **per-tile daily
 * totals**, summed. That is deliberate and not merely convenient: a per-zone
 * delta walk needs every event a zone ever had, so with events tiled, a zone
 * whose earlier history sits in an unloaded tile has nothing to subtract from
 * and its first loaded event books the zone's whole lifetime as one day's
 * change. Summing pre-aggregated tiles carries no such state and is exact.
 *
 * A single selected zone is the one case that still needs per-event deltas.
 * It only ever needs one tile's shards, so the cost is bounded by that tile.
 */

import {
  eventUrl,
  loadJsonGz,
  loadShard,
  type Columns,
  type Meta,
} from "./data";

export interface HistorySeries {
  days: Int32Array;
  legion: Float64Array;
  swarm: Float64Array;
  faceless: Float64Array;
}

export type ZoneFilter = Uint8Array | null;

/** Sparse [day, legion, swarm, faceless] rows, per tile. */
export type TileSeries = Record<string, number[][]>;

/**
 * Every tile's daily series, in two files.
 *
 * The past is immutable and cached hard; only the current year's file changes
 * between nightly runs. Concatenating them is correct because both hold
 * absolute cumulative totals, so the current-year rows simply continue.
 */
export async function loadTileSeries(base: string, meta: Meta): Promise<TileSeries> {
  const parts = [meta.series.tiles.base, meta.series.tiles.current].filter(Boolean);
  const loaded = await Promise.all(
    parts.map((part) => loadJsonGz<{ tiles: TileSeries }>(base, part!.path)),
  );

  const merged: TileSeries = {};
  for (const { tiles } of loaded) {
    for (const [tile, rows] of Object.entries(tiles)) {
      merged[tile] = merged[tile] ? merged[tile].concat(rows) : rows;
    }
  }
  return merged;
}

/** Step lookup over a sparse series: the last row at or before `day`. */
export function valueAt(rows: number[][], day: number): number[] | null {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid][0] <= day) low = mid + 1;
    else high = mid;
  }
  return low === 0 ? null : rows[low - 1];
}

function empty(span: number): HistorySeries {
  const days = new Int32Array(span);
  for (let d = 0; d < span; d++) days[d] = d;
  return {
    days,
    legion: new Float64Array(span),
    swarm: new Float64Array(span),
    faceless: new Float64Array(span),
  };
}

/** Widen one sparse series into a dense one the chart can index by day. */
export function densify(rows: number[][], span: number): HistorySeries {
  const out = empty(span);
  let r = 0;
  let l = 0;
  let s = 0;
  let f = 0;
  for (let d = 0; d < span; d++) {
    while (r < rows.length && rows[r][0] <= d) {
      [, l, s, f] = rows[r];
      r++;
    }
    out.legion[d] = l;
    out.swarm[d] = s;
    out.faceless[d] = f;
  }
  return out;
}

/**
 * Sum the named tiles into one dense series.
 *
 * Each tile is carried forward independently before being added, which is the
 * whole point: a tile with no row on a given day has not gone to zero, it has
 * simply not changed.
 */
export function sumTileSeries(
  series: TileSeries,
  tiles: string[],
  span: number,
): HistorySeries {
  const out = empty(span);
  for (const tile of tiles) {
    const rows = series[tile];
    if (!rows?.length) continue;
    let r = 0;
    let l = 0;
    let s = 0;
    let f = 0;
    for (let d = 0; d < span; d++) {
      while (r < rows.length && rows[r][0] <= d) {
        [, l, s, f] = rows[r];
        r++;
      }
      out.legion[d] += l;
      out.swarm[d] += s;
      out.faceless[d] += f;
    }
  }
  return out;
}

/** Every event shard for one tile, chronological. Cached across calls. */
export async function loadTileEvents(
  base: string,
  meta: Meta,
  tile: string,
  cache: Map<string, Columns>,
  onProgress?: (done: number, total: number) => void,
): Promise<Columns[]> {
  const periods = Object.keys(meta.events)
    .filter((period) => meta.events[period][tile])
    .sort();

  const out: Columns[] = [];
  for (const [i, period] of periods.entries()) {
    const key = `${period}/${tile}`;
    let loaded = cache.get(key);
    if (!loaded) {
      const [rows] = meta.events[period][tile];
      loaded = await loadShard(eventUrl(base, period, tile), meta.schemas.event, rows);
      cache.set(key, loaded);
    }
    out.push(loaded);
    onProgress?.(i + 1, periods.length);
  }
  return out;
}

/**
 * Build a daily series over `shards` for the zones `filter` accepts.
 *
 * Shards must be chronological. Within one shard the rows are grouped by zone
 * rather than by day, which is fine: a delta only ever compares a zone against
 * its own previous value, and days are bucketed independently.
 *
 * Only correct when `shards` holds a zone's *complete* history, which is why
 * this is reserved for single-zone mode over that zone's own tile.
 */
export function buildSeries(
  shards: Columns[],
  zoneCount: number,
  filter: ZoneFilter,
  maxDay: number,
): HistorySeries {
  const lastLegion = new Int32Array(zoneCount);
  const lastSwarm = new Int32Array(zoneCount);
  const lastFaceless = new Int32Array(zoneCount);

  const span = maxDay + 1;
  const dLegion = new Float64Array(span);
  const dSwarm = new Float64Array(span);
  const dFaceless = new Float64Array(span);

  for (const columns of shards) {
    const { idx, day, legion_count, swarm_count, faceless_count } = columns;
    const n = idx.length;
    for (let i = 0; i < n; i++) {
      const z = idx[i];
      const l = legion_count[i];
      const s = swarm_count[i];
      const f = faceless_count[i];

      if (!filter || filter[z] === 1) {
        const d = day[i];
        if (d <= maxDay) {
          dLegion[d] += l - lastLegion[z];
          dSwarm[d] += s - lastSwarm[z];
          dFaceless[d] += f - lastFaceless[z];
        }
      }
      lastLegion[z] = l;
      lastSwarm[z] = s;
      lastFaceless[z] = f;
    }
  }

  const out = empty(span);
  let cl = 0;
  let cs = 0;
  let cf = 0;
  for (let d = 0; d < span; d++) {
    out.legion[d] = cl += dLegion[d];
    out.swarm[d] = cs += dSwarm[d];
    out.faceless[d] = cf += dFaceless[d];
  }
  return out;
}

export function singleZoneFilter(zoneCount: number, idx: number): ZoneFilter {
  const mask = new Uint8Array(zoneCount);
  mask[idx] = 1;
  return mask;
}
