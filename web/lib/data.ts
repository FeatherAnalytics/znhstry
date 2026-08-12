/**
 * The manifest, and what a zone is in words.
 *
 * Decoding lives in `format.ts`, which the display worker shares. This file is
 * the shape of `meta.json` plus the one piece of domain logic that does not
 * belong to either: resolving a zone's administrative labels.
 */

import type { GeometryMeta, ZoneGeometry } from "./geometry";
import type { DisplayMeta } from "./displayProtocol";
import type { AreaSeriesMeta } from "./series";
import type { ZoneHistoryMeta } from "./zoneHistory";
import type { NamesMeta } from "./names";
import type { ShardEntry } from "./format";

export type { ColumnSpec, Columns, Dtype, ShardEntry } from "./format";
export {
  dataUrl,
  dateToDay,
  dayToDate,
  factionOf,
  fetchBytes,
  loadShard,
  magnitudeOf,
  yearOfDay,
} from "./format";

/** id -> [iso_code, name] and id -> [name, country_id]. */
export interface Lookups {
  countries: Record<string, [string, string]>;
  regions: Record<string, [string, number]>;
}

export interface SparseSeries {
  columns: string[];
  rows: number[][];
}

import type { MazEntry } from "./maz";

export interface Meta {
  /** Most Active Zones, `(idx, day)`. Absent until an export has written it. */
  maz?: MazEntry;
  scope: {
    name: string;
    label: string;
    zone_count: number;
    /** Zones that have ever held a bot; the rest are real but never played. */
    active_count: number;
    radius_km: number | null;
  };
  day_epoch: string;
  date_range: [string, string];
  factions: Record<string, string>;
  /**
   * Headline figures for the state the paint bundle draws, so the panel is
   * right on the first frame rather than showing zeroes until anything else
   * lands.
   */
  current: { date: string; legion: number; swarm: number; faceless: number; held: number };
  geometry: GeometryMeta;
  /** Zone names by block of index, fetched on hover. Never on the load path. */
  names: NamesMeta;
  zone_ids: ShardEntry;
  lookups: { path: string; bytes: number };
  /** One byte per zone-day: the whole history of what the map draws. */
  display: DisplayMeta;
  /** Exact per-faction counts, sharded by block of zone index. */
  zone_history: ZoneHistoryMeta;
  series: Record<string, { path: string }>;
  /** Precomputed daily totals per country, region, and one-degree cell. */
  area_series: AreaSeriesMeta;
  notes: string[];
}

/** What a zone is, in words: its id and where it is. */
export interface ZoneIdentity {
  zoneId: number | null;
  name: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
}

/**
 * Resolve a zone's administrative labels.
 *
 * Both labels come straight from the zone's own ids, which is what the game
 * shows. For 447 zones the region belongs to a different country than the zone
 * does - a zone filed under a Polish voivodeship sits at 161E in the Solomon
 * Islands - and the pairing reads as nonsense because it is nonsense, upstream.
 *
 * Printed anyway, because the alternative is a hover that names no region for a
 * zone the game says is in one, and because our region totals are counted the
 * same way: QONQR's site reports 1,890 zones in West Pomeranian Voivodeship and
 * we report 1,890. A label that disagreed with its own count would be worse than
 * a label that disagrees with a map.
 *
 * `zoneIds` and the name may still be in flight - both load behind the map -
 * so either can come back null and the caller shows what it has.
 */
export function zoneIdentity(
  geometry: ZoneGeometry,
  lookups: Lookups | null,
  zoneIds: Int32Array | null,
  idx: number,
): ZoneIdentity {
  const countryId = geometry.country[idx];
  const regionId = geometry.region[idx];

  const country = lookups?.countries[String(countryId)] ?? null;
  const region = lookups?.regions[String(regionId)] ?? null;

  return {
    zoneId: zoneIds ? zoneIds[idx] : null,
    name: geometry.names[idx] ?? null,
    region: region ? region[0] : null,
    country: country ? country[1] : null,
    countryCode: country ? country[0] : null,
  };
}

export async function loadMeta(base: string): Promise<Meta> {
  const { dataUrl } = await import("./format");
  const response = await fetch(dataUrl(`${base}/meta.json`));
  if (!response.ok) throw new Error(`${response.status} for meta.json`);
  return response.json();
}

/**
 * Upstream ZoneIds, in index order.
 *
 * 141 KB, because index order is zone_id order and the differences are 1s and
 * 2s. Flat it would be 4.2 MB, which is why it is its own file rather than a
 * column in the geometry, where it would delay every dot on the map for the
 * sake of a hover readout.
 */
export async function loadZoneIds(base: string, entry: ShardEntry): Promise<Int32Array> {
  const { loadShard } = await import("./format");
  return (await loadShard(base, entry)).zone_id as Int32Array;
}

export async function loadJson<T>(base: string, path: string): Promise<T> {
  const { dataUrl } = await import("./format");
  const response = await fetch(dataUrl(`${base}/${path}`));
  if (!response.ok) throw new Error(`${response.status} for ${path}`);
  return response.json();
}
