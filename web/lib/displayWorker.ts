/// <reference lib="webworker" />

/**
 * Rebuilding what the map draws, off the main thread.
 *
 * State on day D is the anchor for D's year plus every row in that year's shard
 * up to D. That is two fetches worth at most 3.16 MB, and a rebuild is a pass
 * over about 1.6M anchor rows and at most 1.4M shard rows - a few milliseconds.
 *
 * **Every request is a full rebuild**, and that is the point: forwards and
 * backwards cost the same and nothing has to be undone. Carrying exact
 * per-faction counts instead would make a rebuild a 1.3M-row replay too slow
 * for frame rate, which in turn needs a forward-only fast path, a day index
 * built by counting sort on every shard, and a rule that scrubbing backwards
 * falls back to a rebuild anyway. One byte per zone-day removes the need for
 * all of it.
 */

import { decodeColumns, fetchBytes, yearOfDay, type Columns, type ShardEntry } from "./format";
import type {
  InitMessage,
  PermuteMessage,
  ShowMessage,
  WorkerRequest,
  WorkerResponse,
} from "./displayProtocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;

let config: InitMessage | null = null;

/**
 * The render permutation, grown one tile at a time.
 *
 * `idxOfSlot` drives the gather that hands `pk` back in slot order;
 * `slotOfIdx` is its inverse, which `markMoved` needs because the shards it
 * reads are keyed by idx. Both are derived from the same append, so they cannot
 * drift.
 */
let idxOfSlot: Int32Array | null = null;
let slotOfIdx: Int32Array | null = null;
let slotCount = 0;

function permute(message: PermuteMessage): void {
  const { zoneCount } = config!;
  if (!idxOfSlot) {
    idxOfSlot = new Int32Array(zoneCount);
    slotOfIdx = new Int32Array(zoneCount).fill(-1);
  }
  const { from, idx } = message;
  for (let k = 0; k < idx.length; k++) {
    const slot = from + k;
    idxOfSlot[slot] = idx[k];
    slotOfIdx![idx[k]] = slot;
  }
  slotCount = Math.max(slotCount, from + idx.length);
}
const anchors = new Map<number, Columns>();
const shards = new Map<number, Columns>();
const inflight = new Map<string, Promise<Columns>>();

const post = (message: WorkerResponse, transfer: Transferable[] = []) =>
  scope.postMessage(message, transfer);

/** Fetch and decode one shard, never twice at once. */
function load(dir: string, entry: ShardEntry): Promise<Columns> {
  const key = `${dir}/${entry.path}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = fetchBytes(`${config!.base}/${dir}/${entry.path}`).then((buffer) =>
    decodeColumns(buffer, entry.columns, entry.rows),
  );
  inflight.set(key, promise);
  return promise;
}

async function anchorFor(year: number): Promise<Columns | null> {
  const entry = config!.display.anchors.find((a) => a.year === year);
  if (!entry) return null; // the first year in the record opens from nothing
  const cached = anchors.get(year);
  if (cached) return cached;
  const loaded = await load(config!.display.path, entry);
  anchors.set(year, loaded);
  return loaded;
}

async function shardFor(year: number): Promise<Columns | null> {
  const entry = config!.display.shards.find((s) => s.year === year);
  if (!entry) return null;
  const cached = shards.get(year);
  if (cached) return cached;
  const loaded = await load(config!.display.path, entry);
  shards.set(year, loaded);
  return loaded;
}

/** Grown as flips are found, then trimmed. A busy day is about a thousand. */
interface FlipSink {
  idx: number[];
  from: number[];
  to: number[];
}

/**
 * Fill `pk` with the world on `day`.
 *
 * Rows run `(idx, day)`, so a zone's own rows are chronological and writing
 * them in file order leaves the last one at or before the cutoff standing.
 *
 * `sink`, when present, also collects every zone whose leading faction changed
 * on `day` itself. That is nearly free here and awkward anywhere else: at the
 * moment a row for `day` is written, `pk[idx]` still holds the state built from
 * every earlier row, so the comparison needs no second snapshot and no second
 * pass. Doing it outside would mean rebuilding the previous day as well and
 * diffing 2.68M bytes.
 */
function replay(
  pk: Uint8Array,
  anchor: Columns | null,
  shard: Columns | null,
  day: number,
  sink: FlipSink | null,
): void {
  pk.fill(0);

  if (anchor) {
    const { idx, pk: value } = anchor;
    for (let i = 0; i < idx.length; i++) pk[idx[i]] = value[i];
  }
  if (shard) {
    const { idx, day: rowDay, pk: value } = shard;
    for (let i = 0; i < idx.length; i++) {
      if (rowDay[i] > day) continue;
      const zone = idx[i];
      if (sink && rowDay[i] === day) {
        // Faction is the top two bits. Compare those alone: a zone that merely
        // grew or shrank changed its magnitude bits and did not change hands.
        const before = pk[zone] >> 6;
        const after = value[i] >> 6;
        if (before !== after) {
          sink.idx.push(zone);
          sink.from.push(before);
          sink.to.push(after);
        }
      }
      pk[zone] = value[i];
    }
  }
}

/**
 * Mark every zone that saw an event in `(from, to]`.
 *
 * This is Change mode's whole definition, and it is a question about whether
 * rows exist rather than a comparison of two snapshots - which is why the
 * shards carry a row for every zone-day with an event, not only for the ones
 * that crossed a size bucket. A bucket comparison is 2 MB cheaper across the
 * whole record and would quietly hide every skirmish under a third of a zone's
 * garrison.
 */
function markMoved(visible: Uint8Array, spans: Columns[], from: number, to: number): number {
  visible.fill(0);
  const toSlot = slotOfIdx;
  if (!toSlot) return 0;

  let shown = 0;
  for (const { idx, day } of spans) {
    for (let i = 0; i < idx.length; i++) {
      if (day[i] <= from || day[i] > to) continue;
      // Marked by slot, because that is the order the page draws in. A zone
      // whose tile has not landed has no slot and simply cannot be drawn.
      const slot = toSlot[idx[i]];
      if (slot < 0 || visible[slot] !== 0) continue;
      visible[slot] = 1;
      shown++;
    }
  }
  return shown;
}

/**
 * Carry the standing state forward from `from` to `day`, within one year.
 *
 * Rows for a given day are scattered through the shard, which is ordered
 * `(idx, day)` for compression, so this reads the year once - and because it
 * reads the whole year anyway, **advancing ten days costs the same as advancing
 * one**. That is what makes it usable during playback, where the backdrop is
 * always a little behind the playhead and the days it is asked for arrive in
 * jumps rather than one at a time.
 *
 * Against a rebuild, which clears 2.68M bytes and then scatters ~1.5M anchor
 * writes across the array in idx order, this is a sequential pass writing the
 * few thousand rows that fall in the span. Sequential beats random by more than
 * the row counts suggest.
 *
 * Deliberately no by-day index: it would turn this into ~3,000 reads instead of
 * 1.4M, but costs 5.6 MB per year and a counting sort, for a pass that is
 * already off the critical path once the rebuild is gone. Measure before adding
 * one.
 */
function step(
  state: Uint8Array,
  shard: Columns,
  from: number,
  day: number,
  sink: FlipSink | null,
): void {
  const { idx, day: rowDay, pk: value } = shard;
  for (let i = 0; i < idx.length; i++) {
    if (rowDay[i] <= from || rowDay[i] > day) continue;
    const zone = idx[i];
    if (sink) {
      const before = state[zone] >> 6;
      const after = value[i] >> 6;
      if (before !== after) {
        sink.idx.push(zone);
        sink.from.push(before);
        sink.to.push(after);
      }
    }
    state[zone] = value[i];
  }
}

/**
 * The world as of `stateDay`, held across requests.
 *
 * The worker's own copy rather than whichever buffer the page lent back: a
 * request may be superseded and its buffers returned unused, and an incremental
 * step has to build on the last day *processed*, not the last day drawn.
 */
let state: Uint8Array | null = null;
let stateDay: number | null = null;
let stateYear: number | null = null;

/**
 * Steps between incremental-vs-rebuild checks. 0 disables.
 *
 * Left in, switched off. It reported "incremental matches rebuild" at five
 * checkpoints across a run, which is the only reason the fast path is trusted;
 * anyone changing `step` or `replay` should turn it back on and watch it cross a
 * year boundary before believing the result.
 */
const VERIFY_EVERY = 0;
let sinceVerify = 0;

async function show(message: ShowMessage): Promise<void> {
  const { zoneCount, epoch } = config!;
  const { token, day, windowStart } = message;

  const year = yearOfDay(epoch, day);
  const [anchor, shard] = await Promise.all([anchorFor(year), shardFor(year)]);

  // Change needs every year the window touches, not just the playhead's.
  const spans: Columns[] = [];
  if (windowStart !== null) {
    const first = yearOfDay(epoch, windowStart);
    const wanted = [];
    for (let y = first; y <= year; y++) wanted.push(y);
    for (const columns of await Promise.all(wanted.map(shardFor))) {
      if (columns) spans.push(columns);
    }
  }

  const pk = message.pk ?? new Uint8Array(zoneCount);
  const visible = message.visible ?? new Uint8Array(zoneCount);

  const sink: FlipSink | null = message.flips ? { idx: [], from: [], to: [] } : null;

  if (!state || state.length !== zoneCount) {
    state = new Uint8Array(zoneCount);
    stateDay = null;
  }

  // Any forward move inside the year the state already sits in. A rebuild per
  // day was the whole cost of following the playhead - 42 ms of a 71 ms frame.
  // Going backwards, or crossing into another year, still rebuilds: backwards
  // has nothing to carry forward, and a new year needs its anchor.
  const canStep = stateDay !== null && stateYear === year && day > stateDay && shard !== null;

  if (canStep) step(state, shard!, stateDay!, day, sink);
  else replay(state, anchor, shard, day, sink);

  // Temporary: an incremental step is only worth having if it is identical to
  // the rebuild it replaces. Every Nth step, rebuild into a scratch buffer and
  // compare. Set to 0 once this has been watched across a year boundary.
  if (canStep && VERIFY_EVERY > 0 && ++sinceVerify >= VERIFY_EVERY) {
    sinceVerify = 0;
    const check = new Uint8Array(zoneCount);
    replay(check, anchor, shard, day, null);
    let differing = 0;
    for (let i = 0; i < zoneCount; i++) if (check[i] !== state[i]) differing++;
    console[differing ? "error" : "info"](
      `display verify day ${day}: ${differing ? `${differing} zones DRIFTED` : "incremental matches rebuild"}`,
    );
  }

  stateDay = day;
  stateYear = year;

  // `state` is idx-keyed, because that is what the shards are keyed by and what
  // a carry-forward has to accumulate in. The page draws in slot order, so the
  // permutation happens here - a random read per zone, on the thread that has
  // the frame to itself, instead of the same read inside the draw loop where it
  // measured 155 ms a frame against 64 ms.
  const toIdx = idxOfSlot;
  if (toIdx) for (let s = 0; s < slotCount; s++) pk[s] = state[toIdx[s]];

  // Order-agnostic, and over bytes still in cache from the gather above.
  let held = 0;
  for (let i = 0; i < zoneCount; i++) if (state[i] !== 0) held++;

  const shown =
    windowStart === null
      ? (visible.fill(1), zoneCount)
      : markMoved(visible, spans, windowStart, day);

  const flips = sink
    ? {
        idx: Uint32Array.from(sink.idx),
        from: Uint8Array.from(sink.from),
        to: Uint8Array.from(sink.to),
      }
    : null;

  post({ type: "state", token, day, shown, held, pk, visible, flips }, [
    pk.buffer,
    visible.buffer,
    ...(flips ? [flips.idx.buffer, flips.from.buffer, flips.to.buffer] : []),
  ]);
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (message.type === "init") {
    config = message;
    return;
  }

  if (message.type === "permute") {
    permute(message);
    return;
  }

  show(message).catch((error) =>
    post({ type: "error", token: message.token, message: String(error?.message ?? error) }),
  );
};
