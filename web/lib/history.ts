/**
 * Time series for an arbitrary subset of zones.
 *
 * Events store absolute counts, so a series needs per-event deltas. Recovering
 * them is a linear pass because the shards are already ordered by (zone, day)
 * -- the same layout chosen for compression turns out to be the one this walk
 * wants. Carry a last-seen value per zone across shards in chronological
 * order, subtract, bucket by day, then cumulative-sum: the identical
 * trick the dbt layer uses, and it carries dormant zones forward for free.
 */

import { loadShard, sortByDay, type Columns, type Meta, type ShardEntry } from "./data";

export interface HistorySeries {
  days: Int32Array;
  legion: Float64Array;
  swarm: Float64Array;
  faceless: Float64Array;
}

export type ZoneFilter = ((idx: number) => boolean) | null;

/** Every event shard, in chronological order. Cached across calls. */
export async function loadFullHistory(
  base: string,
  meta: Meta,
  cache: Map<string, { columns: Columns; days: Uint16Array }>,
  onProgress?: (done: number, total: number) => void,
): Promise<Columns[]> {
  const shards = [...meta.events].sort((a, b) => a.year! - b.year! || a.month! - b.month!);
  const out: Columns[] = [];

  for (const [i, entry] of shards.entries()) {
    let loaded = cache.get(entry.path);
    if (!loaded) {
      loaded = sortByDay(await loadShard(`${base}/events`, entry as ShardEntry));
      cache.set(entry.path, loaded);
    }
    out.push(loaded.columns);
    onProgress?.(i + 1, shards.length);
  }
  return out;
}

/**
 * Build a daily series over `shards` for the zones `filter` accepts.
 *
 * Shards must be chronological. Within one shard the rows are grouped by zone
 * rather than by day, which is fine: a delta only ever compares a zone against
 * its own previous value, and days are bucketed independently.
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

      if (!filter || filter(z)) {
        const d = day[i];
        if (d <= maxDay) {
          dLegion[d] += l - lastLegion[z];
          dSwarm[d] += s - lastSwarm[z];
          dFaceless[d] += f - lastFaceless[z];
        }
      }
      // Tracked regardless of the filter so a zone entering the viewport later
      // is compared against its own history, not against zero.
      lastLegion[z] = l;
      lastSwarm[z] = s;
      lastFaceless[z] = f;
    }
  }

  const days = new Int32Array(span);
  const legion = new Float64Array(span);
  const swarm = new Float64Array(span);
  const faceless = new Float64Array(span);
  let cl = 0;
  let cs = 0;
  let cf = 0;
  for (let d = 0; d < span; d++) {
    days[d] = d;
    legion[d] = cl += dLegion[d];
    swarm[d] = cs += dSwarm[d];
    faceless[d] = cf += dFaceless[d];
  }
  return { days, legion, swarm, faceless };
}

/** Mask of zones inside the current map bounds. */
export function viewportFilter(
  zones: Columns,
  bounds: [number, number, number, number],
): ZoneFilter {
  const [west, south, east, north] = bounds;
  const lat = zones.latitude as Float32Array;
  const lon = zones.longitude as Float32Array;
  return (idx: number) =>
    lon[idx] >= west && lon[idx] <= east && lat[idx] >= south && lat[idx] <= north;
}
