/**
 * Loader for the packed, tiled export.
 *
 * Every .gz is a gzip stream over a columnar dump: each column is a contiguous
 * run of one fixed-width dtype, concatenated in schema order. We decompress
 * with the browser's own DecompressionStream and take typed-array views at
 * running offsets, so there is no decoding library and no per-row parsing.
 *
 * Checkpoints and events shard by web-mercator tile as well as by time. The
 * schema is shared by every shard of a kind and lives in `meta.schemas`, not
 * on the individual entries - there are over ten thousand of them.
 */

export type Dtype = "uint8" | "uint16" | "uint32" | "int32" | "float32";
export type ColumnSpec = [name: string, dtype: Dtype, encoding: "delta" | null];

/** What `meta` records per shard: just the two numbers needed to read it. */
export type TileShard = [rows: number, bytes: number];

/** [west, south, east, north] */
export type Bounds = [number, number, number, number];

export interface TileInfo {
  zones: number;
  bbox: Bounds;
}

export interface ZonesEntry {
  path: string;
  rows: number;
  columns: ColumnSpec[];
  bytes: number;
  names: { path: string; bytes: number };
}

/** id -> [iso_code, name] and id -> [name, country_id]. */
export interface Lookups {
  countries: Record<string, [string, string]>;
  regions: Record<string, [string, number]>;
}

export interface Meta {
  scope: { name: string; label: string; zone_count: number; radius_km: number | null };
  day_epoch: string;
  date_range: [string, string];
  factions: Record<string, string>;
  zones: ZonesEntry;
  lookups: { path: string; bytes: number };
  tiling: { zoom: number; scheme: string; key: string };
  tiles: Record<string, TileInfo>;
  schemas: { checkpoint: ColumnSpec[]; event: ColumnSpec[] };
  /** year -> tile -> shard */
  checkpoints: Record<string, Record<string, TileShard>>;
  /** "YYYY-MM" -> tile -> shard */
  events: Record<string, Record<string, TileShard>>;
  series: {
    global_daily: { path: string };
    scope_daily: { path: string };
    country_daily: { path: string };
    tiles: { base?: { path: string }; current?: { path: string } };
  };
  notes: string[];
}

const ARRAY_OF: Record<Dtype, new (b: ArrayBuffer, o: number, n: number) => ArrayBufferView> = {
  uint8: Uint8Array,
  uint16: Uint16Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
};

const BYTES_OF: Record<Dtype, number> = {
  uint8: 1,
  uint16: 2,
  uint32: 4,
  int32: 4,
  float32: 4,
};

export type Columns = Record<string, ArrayBufferView & { [i: number]: number; length: number }>;

async function gunzip(response: Response): Promise<ArrayBuffer> {
  if (!response.ok) throw new Error(`${response.status} ${response.url}`);
  const stream = response.body!.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** Split a decompressed dump into typed-array views, one per column. */
export function decodeColumns(buffer: ArrayBuffer, schema: ColumnSpec[], rows: number): Columns {
  const columns: Columns = {};
  let offset = 0;

  for (const [name, dtype, encoding] of schema) {
    const width = BYTES_OF[dtype];
    // A typed-array view needs its byte offset aligned to the element width,
    // and the single-byte faction column leaves everything after it odd. Copy
    // just those columns into an aligned buffer; the rest stay zero-copy views.
    const aligned = offset % width === 0 ? buffer : buffer.slice(offset, offset + rows * width);
    const view = new ARRAY_OF[dtype](
      aligned,
      aligned === buffer ? offset : 0,
      rows,
    ) as never;
    offset += rows * width;

    if (encoding === "delta") {
      // Stored as successive differences so gzip sees runs of small numbers.
      // Prefix-sum into a fresh array; the view is over the shared buffer.
      const restored = new Uint32Array(rows);
      let running = 0;
      for (let i = 0; i < rows; i++) restored[i] = running += (view as Uint32Array)[i];
      columns[name] = restored as never;
    } else {
      columns[name] = view;
    }
  }
  return columns;
}

/** Fetch and decode one shard. The schema is passed in, not read off the file. */
export async function loadShard(
  url: string,
  schema: ColumnSpec[],
  rows: number,
): Promise<Columns> {
  return decodeColumns(await gunzip(await fetch(url)), schema, rows);
}

export async function loadMeta(base: string): Promise<Meta> {
  const response = await fetch(`${base}/meta.json`);
  if (!response.ok) throw new Error(`${response.status} loading meta.json`);
  return response.json();
}

export async function loadJsonGz<T>(base: string, path: string): Promise<T> {
  const buffer = await gunzip(await fetch(`${base}/${path}`));
  return JSON.parse(new TextDecoder().decode(buffer));
}

export function loadZones(base: string, meta: Meta): Promise<Columns> {
  return loadShard(`${base}/${meta.zones.path}`, meta.zones.columns, meta.zones.rows);
}

/** What a zone is, in words: its id and where it is. */
export interface ZoneIdentity {
  zoneId: number;
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
 */
export function zoneIdentity(
  zones: Columns,
  lookups: Lookups,
  index: number,
): ZoneIdentity {
  const zoneId = (zones.zone_id as Int32Array)[index];
  const countryId = (zones.country_id as Uint16Array)[index];
  const regionId = (zones.region_id as Uint16Array)[index];

  const country = lookups.countries[String(countryId)] ?? null;
  const region = lookups.regions[String(regionId)] ?? null;
  const regionAgrees = region !== null && region[1] === countryId;

  return {
    zoneId,
    region: regionAgrees ? region[0] : null,
    country: country ? country[1] : null,
    countryCode: country ? country[0] : null,
  };
}

export function checkpointUrl(base: string, year: string, tile: string): string {
  return `${base}/checkpoints/${year}/${tile}.bin.gz`;
}

export function eventUrl(base: string, period: string, tile: string): string {
  return `${base}/events/${period}/${tile}.bin.gz`;
}

// --- Tiles ----------------------------------------------------------------

const MERCATOR_LAT_LIMIT = 85.05112878;

/**
 * Which tile a point falls in. Mirrors `_tile_key_sql` in export.py exactly,
 * including the clamps - a mismatch would look up an empty shard and silently
 * render a zone as having no history.
 */
export function tileOf(meta: Meta, lat: number, lon: number): string {
  const side = 2 ** meta.tiling.zoom;
  const clamped = Math.min(Math.max(lat, -MERCATOR_LAT_LIMIT), MERCATOR_LAT_LIMIT);
  const rad = (clamped * Math.PI) / 180;
  const x = Math.min(Math.floor(((lon + 180) / 360) * side), side - 1);
  const y = Math.min(
    Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * side),
    side - 1,
  );
  return `${Math.max(x, 0)}-${Math.max(y, 0)}`;
}

function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Tiles intersecting the viewport, heaviest first.
 *
 * Ordered by zone count so the tiles that dominate the picture arrive first
 * and the map fills in from the middle out rather than in manifest order.
 * Uses the bboxes in `meta` rather than reprojecting the bounds.
 */
export function tilesInBounds(meta: Meta, bounds: Bounds): string[] {
  const [west, south, east, north] = bounds;
  const coversWorld = east - west >= 360;
  const w = wrapLon(west);
  const e = wrapLon(east);
  const wraps = !coversWorld && e < w;

  return Object.entries(meta.tiles)
    .filter(([, tile]) => {
      const [tw, ts, te, tn] = tile.bbox;
      if (tn < south || ts > north) return false;
      if (coversWorld) return true;
      return wraps ? te > w || tw < e : te > w && tw < e;
    })
    .sort((a, b) => b[1].zones - a[1].zones)
    .map(([key]) => key);
}

export function tileCenter(tile: TileInfo): [number, number] {
  const [w, s, e, n] = tile.bbox;
  return [(w + e) / 2, (s + n) / 2];
}

// --- Dates ----------------------------------------------------------------

export function dayToDate(epoch: string, day: number): Date {
  const start = new Date(`${epoch}T00:00:00Z`);
  return new Date(start.getTime() + day * 86_400_000);
}

export function dateToDay(epoch: string, date: Date): number {
  const start = new Date(`${epoch}T00:00:00Z`);
  return Math.floor((date.getTime() - start.getTime()) / 86_400_000);
}

/** The period key an event shard uses: "YYYY-MM". */
export function periodOf(epoch: string, day: number): string {
  const date = dayToDate(epoch, day);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Mutable zone state, indexed by the export's stable zone index.
 *
 * The index is global and stable across tiles, so this stays one flat array
 * however many tiles are loaded; a tile fills in its own scattered slots.
 *
 * Reconstructing a date means starting from the nearest year checkpoint and
 * replaying that year's events up to the target day. The checkpoint is what
 * makes dormant zones appear at all: a third of them have not changed since
 * 2019, so replaying only recent events would render them as empty.
 */
export class ZoneState {
  readonly faction: Uint8Array;
  readonly legion: Int32Array;
  readonly swarm: Int32Array;
  readonly faceless: Int32Array;
  readonly total: Int32Array;

  constructor(readonly size: number) {
    this.faction = new Uint8Array(size);
    this.legion = new Int32Array(size);
    this.swarm = new Int32Array(size);
    this.faceless = new Int32Array(size);
    this.total = new Int32Array(size);
  }

  clear(): void {
    this.faction.fill(0);
    this.legion.fill(0);
    this.swarm.fill(0);
    this.faceless.fill(0);
    this.total.fill(0);
  }

  /** Apply every event on or before `maxDay`.
   *
   * Rows are in file order, (zone, day), so a zone's own events are still
   * chronological and skipping later ones is safe. This replaces a global
   * day-sort that cost O(n log n) per shard to serve a cutoff needed by only
   * the one partial month.
   */
  applyUpToDay(columns: Columns, maxDay: number): void {
    const { idx, day, control_state, legion_count, swarm_count, faceless_count } = columns;
    const n = idx.length;
    for (let i = 0; i < n; i++) {
      if (day[i] > maxDay) continue;
      const z = idx[i];
      this.faction[z] = control_state[i];
      this.legion[z] = legion_count[i];
      this.swarm[z] = swarm_count[i];
      this.faceless[z] = faceless_count[i];
      this.total[z] = legion_count[i] + swarm_count[i] + faceless_count[i];
    }
  }

  applyAll(columns: Columns): void {
    const { idx, control_state, legion_count, swarm_count, faceless_count } = columns;
    for (let i = 0; i < idx.length; i++) {
      const z = idx[i];
      this.faction[z] = control_state[i];
      this.legion[z] = legion_count[i];
      this.swarm[z] = swarm_count[i];
      this.faceless[z] = faceless_count[i];
      this.total[z] = legion_count[i] + swarm_count[i] + faceless_count[i];
    }
  }

  /** How many of the loaded zones are held. Only meaningful for loaded tiles. */
  heldCount(): number {
    let held = 0;
    for (let i = 0; i < this.size; i++) if (this.faction[i] > 0 && this.total[i] > 0) held++;
    return held;
  }
}
