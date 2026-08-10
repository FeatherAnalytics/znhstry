/**
 * Progressive zone geometry.
 *
 * The export shards the world into a 16-degree grid. This is sharding, not
 * level of detail: every tile is eventually fetched and every zone is drawn as
 * itself. The grid exists only so the patch of world you are looking at can
 * arrive before Antarctica does.
 *
 * Two files per tile, fetched together so a tile is never on screen uncoloured:
 *
 *   tiles/  every zone in the tile - position, region, country, and whether it
 *           has ever held a bot. One file, not one per kind of zone: splitting
 *           played from never-played meant a zone crossing between them changed
 *           two files, and drew all the grey on top of all the colour.
 *   paint/  one byte each - faction in the top two bits, a log bucket for size
 *           in the low six. Row-aligned to tiles/, and the reason the map can be
 *           complete and correct with no history loaded at all.
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

import { decodeColumns, fetchBytes, requireRows, type ColumnSpec, type Dtype } from "./format";

export interface GeometryMeta {
  tile_degrees: number;
  coord_scale: number;
  magnitude_steps: number;
  paths: { tiles: string; paint: string };
  position_columns: ColumnSpec[];
  paint_columns: ColumnSpec[];
  tile_fields: string[];
  /**
   * [name, zones, played, tileBytes, paintBytes, south, west]
   *
   * Positional, so trailing entries a newer export adds are simply ignored.
   */
  tiles: [string, number, number, number, number, number, number][];
  first_paint_bytes: number;
  names_bytes: number;
}

export interface Tile {
  name: string;
  /** Every zone in the tile. */
  zones: number;
  centerLat: number;
  centerLon: number;
}

export function readTiles(meta: GeometryMeta): Tile[] {
  const half = meta.tile_degrees / 2;
  return meta.tiles.map(([name, zones, , , , south, west]) => ({
    name,
    zones,
    centerLat: south + half,
    centerLon: west + half,
  }));
}



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
 *
 * **Both arrays are indexed by `slot`, not by `idx`** - the one place in the
 * app where display state is held in render order rather than game order. The
 * draw loops read every byte of both once per frame, and reaching them through
 * `slotToIdx` is a cache miss per zone: it measured 155 ms a frame against
 * 64 ms for the same loop reading sequentially. The permutation is done by the
 * worker, which is already the only thread writing these bytes and has the
 * frame to itself.
 *
 * Anything holding an `idx` - a hover, a MAZ mark, a flip - must go through
 * `geometry.idxToSlot` first, and check it is not -1.
 */
export class ZoneDisplay {
  /**
   * faction = pk >> 6, magnitude = pk & 63. 0 is an empty zone.
   *
   * By slot. See the class note.
   */
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
  /**
   * The same flag by *slot*, so the render loops never look it up through
   * `slotToIdx`.
   *
   * A second copy of one byte per zone, deliberately. The two draw loops in
   * `ZoneMap` read it once per zone per frame, and reaching it by idx is a
   * cache miss each time - which is the whole reason `pk` and `visible` are
   * slot-ordered too. 2.68 MB to keep the frame path sequential.
   */
  readonly everActiveBySlot: Uint8Array;
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
    this.everActiveBySlot = new Uint8Array(size);
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
): number {
  requireRows(buffer, rows, meta.position_columns, "positions");

  // The shared decoder, not a local copy of it. It handles the one case a
  // hand-rolled column walk gets wrong: a typed-array view needs its offset to
  // be a multiple of its width, and `ever_active` is a single byte, so every
  // column placed after it would start on an odd offset and throw. It only
  // happens to work here because that column is last, which is an invariant
  // nothing states - reorder `position_columns` in export.py and the local
  // version breaks where this one does not.
  const decoded = decodeColumns(buffer, meta.position_columns, rows);

  const scale = meta.coord_scale;
  const idxColumn = decoded.idx as Int32Array;
  const latColumn = decoded.latitude as Int32Array;
  const lonColumn = decoded.longitude as Int32Array;
  const regionColumn = decoded.region_id as Uint16Array;
  const countryColumn = decoded.country_id as Uint16Array;
  const everActiveColumn = decoded.ever_active as Uint8Array;

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
    geometry.everActive[idx] = everActiveColumn[i];
    geometry.everActiveBySlot[slot] = everActiveColumn[i];
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
  meta: GeometryMeta,
  firstSlot: number,
  rows: number,
  buffer: ArrayBuffer,
): void {
  // Reduced over the manifest's own spec rather than assuming one byte a zone, so
  // this stays right if `paint/` ever gains a column - which is why the manifest
  // carries `paint_columns` at all.
  requireRows(buffer, rows, meta.paint_columns, "paint");
  const pk = new Uint8Array(buffer, 0, rows);
  // `paint/` is row-aligned to its tile, and a tile's rows are exactly one run
  // of slots - so with `pk` held by slot this is a copy rather than a scatter
  // through `slotToIdx`.
  display.pk.set(pk, firstSlot);
}

export interface LoaderHandle {
  /** Re-sort the queue around a new focus. Cheap; call it while panning. */
  focus(lat: number, lon: number): void;
  cancel(): void;
  readonly done: Promise<void>;
}

export type LoadStage = "zones";

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
    // Every zone in the tile, positions and paint together, so a tile is never
    // on screen uncoloured. Two requests, one await, so the pair lands as a unit
    // and the second does not queue behind another tile's first.
    //
    // One pass, not two. Terrain used to load in a second stage after the played
    // world, which meant every grey dot drew on top of every coloured one, and a
    // zone played for the first time moved between two files that are both served
    // immutable. Merged, they interleave in the tile's own spatial order and a
    // first play only changes a byte of paint.
    await drain(
      "zones",
      all.filter((t) => t.zones > 0),
      async (tile) => {
        const [positions, paint] = await Promise.all([
          fetchBytes(`${base}/${paths.tiles}/${tile.name}.bin.br`),
          fetchBytes(`${base}/${paths.paint}/${tile.name}.bin.br`),
        ]);
        if (cancelled) return;
        const firstSlot = absorbPositions(geometry, meta, tile.zones, positions);
        absorbPaint(geometry, display, meta, firstSlot, tile.zones, paint);
      },
    );

    // One pass only. Names are 12.6 MB for a readout most visits never ask for,
    // so they are fetched a block at a time on hover; see lib/names.ts.
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
