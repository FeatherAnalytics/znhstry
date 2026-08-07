/**
 * Bot counts over time, for whatever the reader has selected.
 *
 * The export precomputes these at three grains and this reads them. Computing
 * them on the client instead means holding all 9.88M events in memory and
 * walking them on every filter change, which is the single requirement that
 * would put the whole event stream back on the critical path.
 *
 *   country   exact, one row per country-day that moved
 *   region    exact, and only for zones whose country agrees with the region
 *   1deg cell for a circle or a viewport, which no precomputation can name
 *             ahead of time. Sharded by the same 16-degree tiles as the map.
 *
 * Everything is stored as per-day *deltas* and prefix-summed here. A delta is a
 * small number that compresses; a running total is a seven-digit one that does
 * not. Summing deltas is also what carries a dormant area forward for free -
 * an area with no row on a day simply keeps yesterday's total.
 */

import { fetchBytes, decodeColumns, type ColumnSpec, type Columns } from "./format";

export interface HistorySeries {
  days: Int32Array;
  legion: Float64Array;
  swarm: Float64Array;
  faceless: Float64Array;
}

export interface AreaSeriesEntry {
  path: string;
  rows: number;
  columns: ColumnSpec[];
  bytes: number;
}

export interface CellSeriesMeta {
  path: string;
  cell_degrees: number;
  cells_per_tile: number;
  columns: ColumnSpec[];
  /** [name, rows, bytes] per 8-degree tile. */
  shards: [string, number, number][];
  bytes: number;
}

export interface AreaSeriesMeta {
  country: AreaSeriesEntry;
  region: AreaSeriesEntry;
  cells: CellSeriesMeta;
}

const cache = new Map<string, Promise<Columns>>();

function fetchColumns(url: string, spec: ColumnSpec[], rows: number): Promise<Columns> {
  const existing = cache.get(url);
  if (existing) return existing;
  const promise = fetchBytes(url).then((buffer) => decodeColumns(buffer, spec, rows));
  cache.set(url, promise);
  return promise;
}

export function loadAreaSeries(base: string, entry: AreaSeriesEntry): Promise<Columns> {
  return fetchColumns(`${base}/${entry.path}`, entry.columns, entry.rows);
}

/** Accumulate day-bucketed deltas, then prefix-sum into running totals. */
function densify(
  span: number,
  add: (legion: Float64Array, swarm: Float64Array, faceless: Float64Array) => void,
): HistorySeries {
  const legion = new Float64Array(span);
  const swarm = new Float64Array(span);
  const faceless = new Float64Array(span);
  add(legion, swarm, faceless);

  const days = new Int32Array(span);
  let cl = 0;
  let cs = 0;
  let cf = 0;
  for (let d = 0; d < span; d++) {
    days[d] = d;
    legion[d] = cl += legion[d];
    swarm[d] = cs += swarm[d];
    faceless[d] = cf += faceless[d];
  }
  return { days, legion, swarm, faceless };
}

/** First row for `areaId` in a column set sorted by (area_id, day). */
function lowerBound(area: ArrayBufferView & { [i: number]: number; length: number }, id: number) {
  let low = 0;
  let high = area.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (area[mid] < id) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Exact daily totals for one country or one region. */
export function seriesForArea(columns: Columns, areaId: number, maxDay: number): HistorySeries {
  const { area_id, day, legion, swarm, faceless } = columns;
  return densify(maxDay + 1, (l, s, f) => {
    for (let i = lowerBound(area_id, areaId); i < area_id.length && area_id[i] === areaId; i++) {
      const d = day[i];
      if (d > maxDay) continue;
      l[d] += legion[i];
      s[d] += swarm[i];
      f[d] += faceless[i];
    }
  });
}

/** One-degree cells, addressed as they are sharded: tile name, then cell in it. */
export type CellSelection = Map<string, Set<number>>;

type CellGrid = Pick<CellSeriesMeta, "cell_degrees" | "cells_per_tile">;

/**
 * Which tile a point's cell lives in, and which of that tile's cells it is.
 *
 * Mirrors the export exactly: tiles are `cell_degrees * cells_per_tile` wide,
 * and a cell's index inside one is row-major from its south-west corner. The
 * clamp catches a zone exactly on the pole or the antimeridian, which would
 * otherwise address a tile one past the end of the grid.
 */
export function cellKey(meta: CellGrid, lat: number, lon: number): [string, number] {
  const per = meta.cells_per_tile;
  const tile = meta.cell_degrees * per;
  const y = Math.min(Math.max(lat + 90, 0), 180 - 1e-9);
  const x = Math.min(Math.max(lon + 180, 0), 360 - 1e-9);
  const name = `${String(Math.floor(y / tile)).padStart(2, "0")}_${String(
    Math.floor(x / tile),
  ).padStart(2, "0")}`;
  const cell =
    Math.floor((y % tile) / meta.cell_degrees) * per +
    Math.floor((x % tile) / meta.cell_degrees);
  return [name, cell];
}

function addCell(selection: CellSelection, meta: CellGrid, lat: number, lon: number) {
  const [name, cell] = cellKey(meta, lat, lon);
  const set = selection.get(name);
  if (set) set.add(cell);
  else selection.set(name, new Set([cell]));
}

/** Every one-degree cell whose centre falls inside a circle. */
export function cellsInCircle(
  meta: CellSeriesMeta,
  lat: number,
  lon: number,
  radiusKm: number,
): CellSelection {
  const selection: CellSelection = new Map();
  const step = meta.cell_degrees;
  const latSpan = radiusKm / 111.32;

  for (let y = Math.floor(lat - latSpan); y <= Math.ceil(lat + latSpan); y += step) {
    const cosine = Math.cos((y * Math.PI) / 180);
    const lonSpan = cosine > 0.01 ? radiusKm / (111.32 * cosine) : 180;
    for (let x = Math.floor(lon - lonSpan); x <= Math.ceil(lon + lonSpan); x += step) {
      // Centre of the cell, so a cell counts when most of it is inside.
      if (haversineKm(lat, lon, y + step / 2, x + step / 2) <= radiusKm) {
        addCell(selection, meta, y, ((x + 180) % 360 + 360) % 360 - 180);
      }
    }
  }
  return selection;
}

export function cellsInBounds(
  meta: CellSeriesMeta,
  [west, south, east, north]: [number, number, number, number],
): CellSelection {
  const selection: CellSelection = new Map();
  const step = meta.cell_degrees;
  const spanLon = Math.min(east - west, 360);
  for (let y = Math.floor(south); y <= Math.ceil(north); y += step) {
    for (let i = 0; i <= Math.ceil(spanLon); i += step) {
      addCell(selection, meta, y, ((west + i + 180) % 360 + 360) % 360 - 180);
    }
  }
  return selection;
}

export async function seriesForCells(
  base: string,
  meta: CellSeriesMeta,
  selection: CellSelection,
  maxDay: number,
): Promise<HistorySeries> {
  const rowsByName = new Map(meta.shards.map(([name, rows]) => [name, rows]));
  const wanted = [...selection.keys()].filter((name) => rowsByName.has(name));

  const loaded = await Promise.all(
    wanted.map((name) =>
      fetchColumns(`${base}/${meta.path}/${name}.bin.br`, meta.columns, rowsByName.get(name)!),
    ),
  );

  return densify(maxDay + 1, (l, s, f) => {
    for (let t = 0; t < loaded.length; t++) {
      const { cell, day, legion, swarm, faceless } = loaded[t];
      const keep = selection.get(wanted[t])!;
      for (let i = 0; i < cell.length; i++) {
        const d = day[i];
        if (d > maxDay || !keep.has(cell[i])) continue;
        l[d] += legion[i];
        s[d] += swarm[i];
        f[d] += faceless[i];
      }
    }
  });
}

/** Widen the export's sparse scope JSON into the same dense shape. */
export function densifyScope(rows: number[][], maxDay: number): HistorySeries {
  const span = maxDay + 1;
  const out: HistorySeries = {
    days: new Int32Array(span),
    legion: new Float64Array(span),
    swarm: new Float64Array(span),
    faceless: new Float64Array(span),
  };
  let r = 0;
  let l = 0;
  let s = 0;
  let f = 0;
  for (let d = 0; d < span; d++) {
    while (r < rows.length && rows[r][0] <= d) {
      [, l, s, f] = rows[r];
      r++;
    }
    out.days[d] = d;
    out.legion[d] = l;
    out.swarm[d] = s;
    out.faceless[d] = f;
  }
  return out;
}

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(h));
}
