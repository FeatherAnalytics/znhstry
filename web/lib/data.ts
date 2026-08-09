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

export interface Meta {
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
 * `country_id` is authoritative and `region_id` is not: 447 zones carry a
 * region belonging to a different country, and checking their coordinates
 * settles it every time - zones the data files under a Polish voivodeship sit
 * at 161E in the Solomon Islands. So the region is shown only when its own
 * country agrees with the zone's, and dropped rather than printed as nonsense.
 *
 * The upstream data is the source of truth here, weird geography included.
 * This suppresses a label it can prove is contradictory; it does not correct
 * anything.
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
  const regionAgrees = region !== null && region[1] === countryId;

  return {
    zoneId: zoneIds ? zoneIds[idx] : null,
    name: geometry.names[idx] ?? null,
    region: regionAgrees ? region[0] : null,
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
