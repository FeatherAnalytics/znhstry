/**
 * Progressive zone geometry.
 *
 * The export shards the world into an 8-degree grid. This is sharding, not
 * level of detail: every tile is eventually fetched and every zone is drawn as
 * itself. The grid exists only so the patch of world you are looking at can
 * arrive before Antarctica does.
 *
 * Three files per tile, fetched in this order:
 *
 *   tiles/   positions of zones that have ever held a bot
 *   paint/   one byte each for those zones - faction in the top two bits, a log
 *            bucket for size in the low six. Row-aligned to tiles/, and the
 *            reason the map can be complete and correct with no history at all.
 *   terrain/ positions of zones never played in fourteen years. Always grey,
 *            so they carry no paint and load last.
 *
 * Names are not here. They are keyed by zone index and fetched on hover.
 *
 * Two index spaces meet here and confusing them is the easiest bug to write:
 *
 *   idx   the export's permanent handle for a zone. Checkpoints, events and
 *         ZoneState are all keyed by it. Stable across nightly runs.
 *   slot  a zone's position in the render buffer, assigned in arrival order.
 *         Meaningless outside this session; deck.gl picks return it.
 *
 * `slotToIdx` and `idxToSlot` convert. Anything touching game state wants idx;
 * anything touching a GPU buffer wants slot.
 */

import { fetchBytes, type ColumnSpec, type Dtype } from "./format";

export interface GeometryMeta {
  tile_degrees: number;
  coord_scale: number;
  magnitude_steps: number;
  paths: { tiles: string; paint: string; terrain: string };
  position_columns: ColumnSpec[];
  paint_columns: ColumnSpec[];
  tile_fields: string[];
  /** [name, played, terrain, tileBytes, paintBytes, terrainBytes, south, west] */
  tiles: [string, number, number, number, number, number, number, number][];
  first_paint_bytes: number;
  terrain_bytes: number;
  names_bytes: number;
}

export interface Tile {
  name: string;
  played: number;
  terrain: number;
  bytes: number;
  centerLat: number;
  centerLon: number;
  /** Render slot of the first played row, and of the first terrain row. */
  playedSlot: number;
  terrainSlot: number;
}

export function readTiles(meta: GeometryMeta): Tile[] {
  const half = meta.tile_degrees / 2;
  return meta.tiles.map(([name, played, terrain, tileBytes, paintBytes, , south, west]) => ({
    name,
    played,
    terrain,
    bytes: tileBytes + paintBytes,
    centerLat: south + half,
    centerLon: west + half,
    playedSlot: -1,
    terrainSlot: -1,
  }));
}

const BYTES_OF: Record<Dtype, number> = {
  uint8: 1,
  uint16: 2,
  uint32: 4,
  int32: 4,
  float32: 4,
};

/**
 * What the map draws, in one byte per zone.
 *
 * `pk` packs the faction into the top two bits and a log bucket of the bot
 * count into the low six - the same byte `paint/` and the whole `display/`
 * stream are stored in, so there is one representation of "what the map shows"
 * and nothing ever converts between two. The paint files fill it directly on
 * first load; after that the display worker hands back a filled copy for
 * whatever date the reader is on.
 *
 * It is deliberately not the exact per-faction counts. Those live in
 * `zone_history/` and are fetched for one zone at a time, because a bucketed
 * magnitude is all a dot on a screen can express and pretending otherwise is
 * what cost 71.5 MB.
 */
export class ZoneDisplay {
  /** faction = pk >> 6, magnitude = pk & 63. 0 is an empty zone. */
  pk: Uint8Array;
  /**
   * 1 to draw the zone at all.
   *
   * Only a change window ever clears this, and it is a genuine hide rather
   * than a dim: the question "what moved this week" is answered by an empty
   * map with a few hundred dots on it, not by a full map with most of it
   * turned down.
   */
  visible: Uint8Array;

  constructor(
    readonly size: number,
    readonly magnitudeSteps: number,
  ) {
    this.pk = new Uint8Array(size);
    this.visible = new Uint8Array(size).fill(1);
  }

  /** deck.gl wants metres; undo the bucketing the export applied. */
  radius(magnitude: number): number {
    return 600 + ((magnitude - 1) / this.magnitudeSteps) * 1400;
  }

  /**
   * Roughly how many bots a bucket stands for.
   *
   * Only for a readout that has nothing better yet. The exact figure comes
   * from `zone_history/` once the zone's block lands, and the caller marks
   * this one as approximate rather than printing it as a count.
   */
  approximateTotal(magnitude: number): number {
    return magnitude === 0 ? 0 : Math.round(10 ** ((magnitude - 1) / this.magnitudeSteps) - 1);
  }
}

/**
 * Everything static about every zone, filled in tile by tile.
 *
 * Arrays keyed by idx are allocated up front for the whole world - 2.68M
 * entries is about 30 MB, cheaper than growing and copying - and coordinates
 * start as NaN so an unloaded zone fails a bounds test rather than sitting at
 * (0, 0) in the Gulf of Guinea.
 */
export class ZoneGeometry {
  readonly positions: Float32Array;
  readonly slotToIdx: Int32Array;
  readonly idxToSlot: Int32Array;

  readonly latitude: Float32Array;
  readonly longitude: Float32Array;
  readonly region: Uint16Array;
  readonly country: Uint16Array;
  /** 1 if the zone has ever held a bot. The rest are real but never played. */
  readonly everActive: Uint8Array;
  readonly names: string[];

  /** Slots filled so far. Everything at or past this is not yet loaded. */
  count = 0;

  constructor(readonly size: number) {
    this.positions = new Float32Array(size * 2);
    this.slotToIdx = new Int32Array(size);
    this.idxToSlot = new Int32Array(size).fill(-1);
    this.latitude = new Float32Array(size).fill(NaN);
    this.longitude = new Float32Array(size).fill(NaN);
    this.region = new Uint16Array(size);
    this.country = new Uint16Array(size);
    this.everActive = new Uint8Array(size);
    this.names = new Array(size);
  }

  has(idx: number): boolean {
    return this.idxToSlot[idx] >= 0;
  }
}

/** Decode a positions file and splice its rows into the shared geometry. */
function absorbPositions(
  geometry: ZoneGeometry,
  meta: GeometryMeta,
  rows: number,
  buffer: ArrayBuffer,
  everActive: boolean,
): number {
  const rowBytes = meta.position_columns.reduce((n, [, dtype]) => n + BYTES_OF[dtype], 0);
  if (buffer.byteLength < rows * rowBytes) {
    throw new Error(
      `positions have ${buffer.byteLength} bytes for ${rows} zones (need ${rows * rowBytes})`,
    );
  }

  const decoded: Record<string, Int32Array | Uint16Array> = {};
  let offset = 0;

  for (const [name, dtype, encoding] of meta.position_columns) {
    const source =
      dtype === "int32"
        ? new Int32Array(buffer, offset, rows)
        : (new Uint16Array(buffer, offset, rows) as Uint16Array);
    offset += rows * BYTES_OF[dtype];

    if (encoding === "delta") {
      // Signed differences: rows run south to north inside a tile, so
      // longitude resets westward at every new latitude and idx jumps about.
      const restored = new Int32Array(rows);
      let running = 0;
      for (let i = 0; i < rows; i++) restored[i] = running += source[i];
      decoded[name] = restored;
    } else {
      decoded[name] = source;
    }
  }

  const scale = meta.coord_scale;
  const idxColumn = decoded.idx as Int32Array;
  const latColumn = decoded.latitude as Int32Array;
  const lonColumn = decoded.longitude as Int32Array;
  const regionColumn = decoded.region_id as Uint16Array;
  const countryColumn = decoded.country_id as Uint16Array;

  const firstSlot = geometry.count;
  let slot = firstSlot;

  for (let i = 0; i < rows; i++) {
    const idx = idxColumn[i];
    const lat = latColumn[i] / scale;
    const lon = lonColumn[i] / scale;

    geometry.latitude[idx] = lat;
    geometry.longitude[idx] = lon;
    geometry.region[idx] = regionColumn[i];
    geometry.country[idx] = countryColumn[i];
    geometry.everActive[idx] = everActive ? 1 : 0;
    geometry.idxToSlot[idx] = slot;
    geometry.slotToIdx[slot] = idx;
    geometry.positions[slot * 2] = lon;
    geometry.positions[slot * 2 + 1] = lat;
    slot++;
  }

  geometry.count = slot;
  return firstSlot;
}

/**
 * Apply a paint file, which is row-aligned to the tile it belongs to.
 *
 * The length check is the point. `new Uint8Array(buffer, 0, rows)` throws when the
 * body is shorter than the tile claims, and the loader used to swallow that - so a
 * short paint file left every zone in the tile at pk 0, which draws as an empty zone.
 * Positions are absorbed first and succeed, so the symptom was a region present in
 * grey with none of its colour, and nothing said why. Checking here makes the message
 * name the tile and the two numbers that disagree.
 */
function absorbPaint(
  geometry: ZoneGeometry,
  display: ZoneDisplay,
  firstSlot: number,
  rows: number,
  buffer: ArrayBuffer,
): void {
  if (buffer.byteLength < rows) {
    throw new Error(`paint has ${buffer.byteLength} bytes for ${rows} zones`);
  }
  const pk = new Uint8Array(buffer, 0, rows);
  for (let i = 0; i < rows; i++) display.pk[geometry.slotToIdx[firstSlot + i]] = pk[i];
}

export interface LoaderHandle {
  /** Re-sort the queue around a new focus. Cheap; call it while panning. */
  focus(lat: number, lon: number): void;
  cancel(): void;
  readonly done: Promise<void>;
}

export type LoadStage = "played" | "terrain";

export interface LoaderOptions {
  base: string;
  meta: GeometryMeta;
  geometry: ZoneGeometry;
  display: ZoneDisplay;
  focus: { lat: number; lon: number };
  /** Fired after each file lands, with what is still outstanding in this stage. */
  onTile: (stage: LoadStage, remaining: number) => void;
  concurrency?: number;
}

/**
 * Fetch the world, nearest to `focus` first, in three passes.
 *
 * Distance is squared degrees rather than haversine: the queue needs an order,
 * not a measurement, and the two disagree in ways nobody watching a map load
 * would notice. Longitude is scaled by the cosine of the focus latitude so a
 * tile does not count as near just because the meridians have converged.
 */
export function loadGeometry(options: LoaderOptions): LoaderHandle {
  const { base, meta, geometry, display, onTile } = options;
  const concurrency = options.concurrency ?? 8;
  const { paths } = meta;

  const all = readTiles(meta);
  let focus = options.focus;
  let cancelled = false;

  const rank = (tile: Tile): number => {
    const squeeze = Math.cos((focus.lat * Math.PI) / 180);
    let dLon = tile.centerLon - focus.lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    const dLat = tile.centerLat - focus.lat;
    return dLat * dLat + dLon * squeeze * (dLon * squeeze);
  };

  /** Drain a queue nearest-first, re-sorting whenever the focus moves. */
  async function drain(
    stage: LoadStage,
    pending: Tile[],
    work: (tile: Tile) => Promise<void>,
    lanes = concurrency,
  ): Promise<void> {
    let dirty = true;
    let movedTo = focus;

    const next = (): Tile | undefined => {
      if (dirty || movedTo !== focus) {
        pending.sort((a, b) => rank(b) - rank(a)); // furthest first, then pop
        dirty = false;
        movedTo = focus;
      }
      return pending.pop();
    };

    const worker = async (): Promise<void> => {
      for (let tile = next(); tile && !cancelled; tile = next()) {
        try {
          await work(tile);
        } catch (error) {
          // One missing file is a hole in the map, not a dead page - but it is
          // still a hole, and swallowing it silently is how a tile of Ukraine
          // rendered in grey with none of its colour and nothing said why.
          console.warn(`znhstry: ${stage} tile ${tile.name} failed —`, error);
        }
        if (!cancelled) onTile(stage, pending.length);
      }
    };
    await Promise.all(Array.from({ length: lanes }, worker));
  }

  const done = (async () => {
    // 1. The played world: positions and paint together, so a tile is never
    //    on screen uncoloured. Two requests, one await, so the pair lands as
    //    a unit and the second does not queue behind another tile's first.
    await drain(
      "played",
      all.filter((t) => t.played > 0),
      async (tile) => {
        const [positions, paint] = await Promise.all([
          fetchBytes(`${base}/${paths.tiles}/${tile.name}.bin.br`),
          fetchBytes(`${base}/${paths.paint}/${tile.name}.bin.br`),
        ]);
        if (cancelled) return;
        tile.playedSlot = absorbPositions(geometry, meta, tile.played, positions, true);
        absorbPaint(geometry, display, tile.playedSlot, tile.played, paint);
      },
    );

    // 2. The terrain nobody has ever played. Always grey, so no paint.
    await drain(
      "terrain",
      all.filter((t) => t.terrain > 0),
      async (tile) => {
        const buffer = await fetchBytes(`${base}/${paths.terrain}/${tile.name}.bin.br`);
        if (cancelled) return;
        tile.terrainSlot = absorbPositions(geometry, meta, tile.terrain, buffer, false);
      },
    );

    // Two passes only. Names are 12.6 MB for a readout most visits never ask
    // for, so they are fetched a block at a time on hover; see lib/names.ts.
  })();

  return {
    focus(lat, lon) {
      focus = { lat, lon };
    },
    cancel() {
      cancelled = true;
    },
    done,
  };
}
