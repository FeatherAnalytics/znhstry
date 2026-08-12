/**
 * Grouping a MAZ day's zones by distance rather than by administrative label.
 *
 * This is the browser half of `pipeline/src/znhstry/distance.py`. The two are
 * kept in step by having the same values and the same rules, not by any
 * mechanism - the same arrangement `EARTH_RADIUS_KM` already has between
 * `config.py` and `lib/series.ts`. Change one and change the other.
 *
 * **Why it is here and not precomputed in the export.** The clusters are a
 * function of coordinates the viewer already holds at the same `idx`, and
 * `CLAUDE.md` is explicit that a second copy of a coordinate is a second chance
 * to disagree. Computing them from the tiles the map itself draws means the
 * bench and the map can never tell different stories about where a zone is.
 *
 * The cost is that a page wanting clusters has to fetch the geometry - 9.27 MB
 * across 168 tiles, the same bytes the map loads. `loadZoneCoords` therefore
 * keeps only the zones it was asked about and drops every other row as it goes,
 * so the 2.68M-zone world becomes a map of about 11,700 entries.
 */

import { fetchBytes, decodeColumns, requireRows, type ColumnSpec } from "./format";
import { haversineKm } from "./series";

/**
 * Thirty miles, in kilometres. Must equal `config.NEIGHBORHOOD_KM`.
 *
 * The scale at which a group of zones is one neighborhood fight rather than a
 * region's population showing through, and deliberately the same number the map
 * frames a cluster at, so the circle the statistic describes and the circle a
 * reader sees are one circle.
 */
export const NEIGHBORHOOD_KM = 48.28032;

export interface GeometryTiles {
  paths: { tiles: string };
  position_columns: ColumnSpec[];
  coord_scale: number;
  /** [name, zones, played, tileBytes, paintBytes, south, west] */
  tiles: [string, number, number, number, number, number, number][];
}

export interface Coord {
  lat: number;
  lon: number;
  region: number;
  country: number;
}

/**
 * Fetch every geometry tile and keep the coordinates of `wanted` only.
 *
 * `onProgress` reports tiles finished out of the total, because this is 168
 * requests and a page that says nothing for nine megabytes reads as broken.
 *
 * Tiles are fetched a few at a time rather than all at once: the data host is an
 * `r2.dev` URL with no CDN in front of it, and requests rather than bytes are
 * the binding constraint there.
 */
export async function loadZoneCoords(
  base: string,
  meta: GeometryTiles,
  wanted: Set<number>,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<number, Coord>> {
  const found = new Map<number, Coord>();
  const tiles = meta.tiles.filter(([, zones]) => zones > 0);
  const scale = meta.coord_scale;
  let done = 0;

  const CONCURRENCY = 6;
  let cursor = 0;

  async function worker() {
    for (;;) {
      const mine = cursor++;
      if (mine >= tiles.length) return;
      const [name, zones] = tiles[mine];

      const buffer = await fetchBytes(`${base}/${meta.paths.tiles}/${name}.bin.br`);
      requireRows(buffer, zones, meta.position_columns, `tiles/${name}`);
      const decoded = decodeColumns(buffer, meta.position_columns, zones);

      const idx = decoded.idx as Int32Array;
      const lat = decoded.latitude as Int32Array;
      const lon = decoded.longitude as Int32Array;
      const region = decoded.region_id as Uint16Array;
      const country = decoded.country_id as Uint16Array;

      for (let i = 0; i < zones; i++) {
        if (!wanted.has(idx[i])) continue;
        found.set(idx[i], {
          lat: lat[i] / scale,
          lon: lon[i] / scale,
          region: region[i],
          country: country[i],
        });
      }
      onProgress?.(++done, tiles.length);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return found;
}

// --- the primitives, ported ---------------------------------------------------

export interface Spread {
  count: number;
  diameterKm: number;
  meanPairKm: number;
  closestPairKm: number;
}

/**
 * Pairwise spread of a set of points.
 *
 * Returns null below two points rather than zeros: a single point has no pairs,
 * and a zero would sort straight to the top of the "which cluster is tightest"
 * ranking this exists to serve.
 */
export function spread(points: Coord[]): Spread | null {
  if (points.length < 2) return null;

  let max = 0;
  let min = Infinity;
  let total = 0;
  let pairs = 0;

  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const km = haversineKm(points[i].lat, points[i].lon, points[j].lat, points[j].lon);
      if (km > max) max = km;
      if (km < min) min = km;
      total += km;
      pairs++;
    }
  }

  return {
    count: points.length,
    diameterKm: max,
    meanPairKm: total / pairs,
    closestPairKm: min,
  };
}

/**
 * Single-linkage grouping: two points join when they are within `withinKm`, and
 * that relation is transitive.
 *
 * **Chaining is wanted, not a flaw to tune away.** A row of zones each 40 km
 * from the next is one front, and splitting it at an arbitrary diameter answers
 * a different question. It does mean a group can be far wider than the cutoff,
 * so groups are ranked by `spread` and never by the cutoff.
 *
 * Singletons come back as one-element groups. A zone fighting alone is a real
 * answer to "how concentrated was this day", and dropping it would make the
 * group count disagree with the input.
 */
export function cluster<T extends Coord>(points: T[], withinKm = NEIGHBORHOOD_KM): T[][] {
  const n = points.length;
  if (n === 0) return [];

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const km = haversineKm(points[i].lat, points[i].lon, points[j].lat, points[j].lon);
      if (km > withinKm) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[b] = a;
    }
  }

  const groups = new Map<number, T[]>();
  const first = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const existing = groups.get(root);
    if (existing) existing.push(points[i]);
    else {
      groups.set(root, [points[i]]);
      first.set(root, i);
    }
  }

  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || first.get(a[0])! - first.get(b[0])!)
    .map(([, group]) => group);
}

// --- over the whole record ----------------------------------------------------

export interface Member extends Coord {
  idx: number;
  launches: number;
}

export interface DayCluster {
  day: number;
  members: Member[];
  spread: Spread;
  /** Distinct region ids the cluster spans - a property of it, not its key. */
  regions: number[];
  countries: number[];
  launches: number;
}

/**
 * Every multi-zone cluster in the record, and the biggest one on each day.
 *
 * A zone with no coordinate is skipped rather than dropped silently at the end:
 * the export's `idx` is stable, so a miss means the geometry has not finished
 * loading, and `missing` is reported so a caller can say the chart is partial
 * instead of drawing a smaller world.
 */
export function clusterRecord(
  reportIdx: Uint32Array,
  reportDay: Uint16Array,
  launches: Int32Array,
  dayMin: number,
  dayMax: number,
  dayOffset: Int32Array,
  coords: Map<number, Coord>,
  withinKm = NEIGHBORHOOD_KM,
): { clusters: DayCluster[]; largestByDay: DayCluster[]; missing: number } {
  const clusters: DayCluster[] = [];
  const largestByDay: DayCluster[] = [];
  let missing = 0;

  for (let d = 0; d <= dayMax - dayMin; d++) {
    const start = dayOffset[d];
    const end = dayOffset[d + 1];
    if (end <= start) continue;

    const day = dayMin + d;
    const points: Member[] = [];
    for (let r = start; r < end; r++) {
      const coord = coords.get(reportIdx[r]);
      if (!coord) {
        missing++;
        continue;
      }
      points.push({ ...coord, idx: reportIdx[r], launches: launches[r] });
    }
    if (points.length < 2) continue;

    let best: DayCluster | null = null;
    for (const group of cluster(points, withinKm)) {
      const measured = spread(group);
      if (!measured) continue;

      const entry: DayCluster = {
        day,
        members: group,
        spread: measured,
        regions: [...new Set(group.map((m) => m.region))],
        countries: [...new Set(group.map((m) => m.country))],
        launches: group.reduce((sum, m) => sum + m.launches, 0),
      };
      clusters.push(entry);
      // Biggest first, tightest to break a tie - the ranking §7.1 settled on.
      if (
        !best ||
        entry.spread.count > best.spread.count ||
        (entry.spread.count === best.spread.count &&
          entry.spread.diameterKm < best.spread.diameterKm)
      ) {
        best = entry;
      }
    }
    if (best) largestByDay.push(best);
  }

  return { clusters, largestByDay, missing };
}
