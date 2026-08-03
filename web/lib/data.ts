/**
 * Loader for the packed export.
 *
 * Every .gz is a gzip stream over a columnar dump: each column is a contiguous
 * run of one fixed-width dtype, concatenated in manifest order. We decompress
 * with the browser's own DecompressionStream and take typed-array views at
 * running offsets, so there is no decoding library and no per-row parsing.
 */

export type Dtype = "uint8" | "uint16" | "uint32" | "int32" | "float32";
export type ColumnSpec = [name: string, dtype: Dtype, encoding: "delta" | null];

export interface ShardEntry {
  path: string;
  rows: number;
  columns: ColumnSpec[];
  bytes: number;
  year?: number;
  month?: number;
}

export interface Meta {
  scope: { name: string; label: string; zone_count: number; radius_km: number | null };
  day_epoch: string;
  date_range: [string, string];
  factions: Record<string, string>;
  zones: ShardEntry & { names: { path: string } };
  checkpoints: ShardEntry[];
  events: ShardEntry[];
  series: Record<string, { path: string }>;
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
  const stream = response.body!.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** Decompress a shard and return its columns as typed-array views. */
export async function loadShard(base: string, entry: ShardEntry): Promise<Columns> {
  const buffer = await gunzip(await fetch(`${base}/${entry.path}`));
  const columns: Columns = {};
  let offset = 0;

  for (const [name, dtype, encoding] of entry.columns) {
    const width = BYTES_OF[dtype];
    // A typed-array view needs its byte offset aligned to the element width,
    // and the single-byte faction column leaves everything after it odd. Copy
    // just those columns into an aligned buffer; the rest stay zero-copy views.
    const aligned =
      offset % width === 0
        ? buffer
        : buffer.slice(offset, offset + entry.rows * width);
    const view = new ARRAY_OF[dtype](
      aligned,
      aligned === buffer ? offset : 0,
      entry.rows,
    ) as never;
    offset += entry.rows * width;

    if (encoding === "delta") {
      // Stored as successive differences so gzip sees runs of small numbers.
      // Prefix-sum into a fresh array; the view is over the shared buffer.
      const restored = new Uint32Array(entry.rows);
      let running = 0;
      for (let i = 0; i < entry.rows; i++) restored[i] = running += (view as Uint32Array)[i];
      columns[name] = restored as never;
    } else {
      columns[name] = view;
    }
  }
  return columns;
}

export async function loadMeta(base: string): Promise<Meta> {
  return (await fetch(`${base}/meta.json`)).json();
}

export async function loadJsonGz<T>(base: string, path: string): Promise<T> {
  const buffer = await gunzip(await fetch(`${base}/${path}`));
  return JSON.parse(new TextDecoder().decode(buffer));
}

export function dayToDate(epoch: string, day: number): Date {
  const start = new Date(`${epoch}T00:00:00Z`);
  return new Date(start.getTime() + day * 86_400_000);
}

export function dateToDay(epoch: string, date: Date): number {
  const start = new Date(`${epoch}T00:00:00Z`);
  return Math.floor((date.getTime() - start.getTime()) / 86_400_000);
}

/**
 * Mutable zone state, indexed by the export's stable zone index.
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

  reset(checkpoint: Columns): void {
    this.faction.fill(0);
    this.legion.fill(0);
    this.swarm.fill(0);
    this.faceless.fill(0);
    this.total.fill(0);
    this.applyRange(checkpoint, 0, checkpoint.idx.length);
  }

  applyRange(columns: Columns, from: number, to: number): void {
    const { idx, control_state, legion_count, swarm_count, faceless_count } = columns;
    for (let i = from; i < to; i++) {
      const z = idx[i];
      this.faction[z] = control_state[i];
      this.legion[z] = legion_count[i];
      this.swarm[z] = swarm_count[i];
      this.faceless[z] = faceless_count[i];
      this.total[z] = legion_count[i] + swarm_count[i] + faceless_count[i];
    }
  }

  totals(): { legion: number; swarm: number; faceless: number; held: number } {
    let legion = 0;
    let swarm = 0;
    let faceless = 0;
    let held = 0;
    for (let i = 0; i < this.size; i++) {
      legion += this.legion[i];
      swarm += this.swarm[i];
      faceless += this.faceless[i];
      if (this.faction[i] > 0) held++;
    }
    return { legion, swarm, faceless, held };
  }
}

/**
 * Event shards are ordered by (zone, day) because that is what compresses.
 * Scrubbing needs them in day order, so we sort once on load and keep the
 * permutation. 300k rows sorts in a few milliseconds.
 */
export function sortByDay(columns: Columns): { columns: Columns; days: Uint16Array } {
  const n = columns.day.length;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const day = columns.day as Uint16Array;
  order.sort((a, b) => day[a] - day[b]);

  const out: Columns = {};
  for (const key of Object.keys(columns)) {
    const source = columns[key] as unknown as { [i: number]: number };
    const target = new (columns[key].constructor as new (n: number) => never)(n) as never as {
      [i: number]: number;
    };
    for (let i = 0; i < n; i++) target[i] = source[order[i]];
    out[key] = target as never;
  }
  return { columns: out, days: out.day as Uint16Array };
}

/** First index whose day is strictly greater than `day`. */
export function upperBound(days: Uint16Array, day: number): number {
  let low = 0;
  let high = days.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (days[mid] <= day) low = mid + 1;
    else high = mid;
  }
  return low;
}
