/**
 * The packed export format, and nothing else.
 *
 * Every `.br` is a brotli stream over a columnar dump: each column is a
 * contiguous run of one fixed-width dtype, concatenated in the order the
 * manifest lists it. The bucket serves it with `Content-Encoding: br`, so the
 * browser has already decompressed it by the time we see it and we take
 * typed-array views at running offsets. No decoding library, no per-row parse.
 *
 * This module has no React and no DOM beyond `fetch`, because the display
 * worker imports it too and a worker has neither.
 */

export type Dtype = "uint8" | "uint16" | "uint32" | "int32" | "float32";
export type ColumnSpec = [name: string, dtype: Dtype, encoding: "delta" | null];

export interface ShardEntry {
  path: string;
  rows: number;
  columns: ColumnSpec[];
  bytes: number;
  year?: number;
}

export type Columns = Record<string, ArrayBufferView & { [i: number]: number; length: number }>;

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

export async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.arrayBuffer();
}

/**
 * Refuse a payload too short for the rows the manifest claims.
 *
 * Views are taken at running offsets, so a truncated or stale body either throws a
 * bare RangeError from deep inside a decoder or - worse - reads a later column out of
 * an earlier one's bytes. A browser holding a stale shard against a fresh manifest is
 * exactly how whole regions of the map silently disappeared, so the check names the
 * shard and both numbers instead.
 */
export function requireRows(
  buffer: ArrayBuffer,
  rows: number,
  spec: ColumnSpec[],
  label: string,
): void {
  const need = spec.reduce((n, [, dtype]) => n + BYTES_OF[dtype], 0) * rows;
  if (buffer.byteLength < need) {
    throw new Error(`${label}: ${buffer.byteLength} bytes for ${rows} rows, need ${need}`);
  }
}

/** Take typed-array views over one decompressed payload. */
export function decodeColumns(
  buffer: ArrayBuffer,
  spec: ColumnSpec[],
  rows: number,
): Columns {
  const columns: Columns = {};
  let offset = 0;

  for (const [name, dtype, encoding] of spec) {
    const width = BYTES_OF[dtype];
    // A typed-array view needs its byte offset aligned to the element width,
    // and a single-byte column leaves everything after it odd. Copy just those
    // into an aligned buffer; the rest stay zero-copy views.
    const aligned = offset % width === 0 ? buffer : buffer.slice(offset, offset + rows * width);
    const view = new ARRAY_OF[dtype](aligned, aligned === buffer ? offset : 0, rows) as never;
    offset += rows * width;

    if (encoding === "delta") {
      // Stored as successive differences so the compressor sees small numbers.
      // Signed columns keep their sign: a delta column is only guaranteed
      // ascending when its dtype is unsigned, and restoring a signed one into
      // a Uint32Array wraps silently.
      const restored = dtype === "int32" ? new Int32Array(rows) : new Uint32Array(rows);
      let running = 0;
      for (let i = 0; i < rows; i++) restored[i] = running += (view as Int32Array)[i];
      columns[name] = restored as never;
    } else {
      columns[name] = view;
    }
  }
  return columns;
}

export async function loadShard(base: string, entry: ShardEntry): Promise<Columns> {
  const buffer = await fetchBytes(`${base}/${entry.path}`);
  requireRows(buffer, entry.rows, entry.columns, entry.path);
  return decodeColumns(buffer, entry.columns, entry.rows);
}

export async function loadJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return response.json();
}

// --- the packed display byte ---------------------------------------------

/**
 * One byte is everything the map draws: who holds a zone in the top two bits,
 * how big to draw it in the low six.
 *
 * `paint/` and the whole of `display/` speak this byte, so there is exactly one
 * representation of "what the map shows" and nothing ever converts between two.
 * 0 is an empty zone whoever nominally holds it - with no bots on the ground
 * there is nothing to own, and the map greys it out.
 */
export const factionOf = (pk: number): number => pk >> 6;
export const magnitudeOf = (pk: number): number => pk & 63;

export function dayToDate(epoch: string, day: number): Date {
  return new Date(new Date(`${epoch}T00:00:00Z`).getTime() + day * 86_400_000);
}

export function dateToDay(epoch: string, date: Date): number {
  return Math.floor((date.getTime() - new Date(`${epoch}T00:00:00Z`).getTime()) / 86_400_000);
}

export function yearOfDay(epoch: string, day: number): number {
  return dayToDate(epoch, day).getUTCFullYear();
}

/**
 * The newest day whose data is finished.
 *
 * Upstream publishes complete days - three runs at 00:02, 01:03 and 12:02 UTC -
 * so every date in the record is whole except the one still happening. That one
 * is genuinely partial: load the page at 02:00 UTC and "the last day" holds a
 * couple of hours of events, which makes a Day window look empty for a reason
 * that has nothing to do with the game.
 *
 * Only the current UTC date is treated as incomplete, so a stale export - whose
 * newest day may be a week old and long since finished - is returned untouched.
 */
export function lastCompleteDay(epoch: string, maxDay: number): number {
  const newest = dayToDate(epoch, maxDay);
  const now = new Date();
  const isToday =
    newest.getUTCFullYear() === now.getUTCFullYear() &&
    newest.getUTCMonth() === now.getUTCMonth() &&
    newest.getUTCDate() === now.getUTCDate();
  return isToday ? maxDay - 1 : maxDay;
}
