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
import type { InitMessage, ShowMessage, WorkerRequest, WorkerResponse } from "./displayProtocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;

let config: InitMessage | null = null;
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

/**
 * Fill `pk` with the world on `day`.
 *
 * Rows run `(idx, day)`, so a zone's own rows are chronological and writing
 * them in file order leaves the last one at or before the cutoff standing.
 */
function replay(pk: Uint8Array, anchor: Columns | null, shard: Columns | null, day: number): void {
  pk.fill(0);

  if (anchor) {
    const { idx, pk: value } = anchor;
    for (let i = 0; i < idx.length; i++) pk[idx[i]] = value[i];
  }
  if (shard) {
    const { idx, day: rowDay, pk: value } = shard;
    for (let i = 0; i < idx.length; i++) {
      if (rowDay[i] <= day) pk[idx[i]] = value[i];
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
  let shown = 0;
  for (const { idx, day } of spans) {
    for (let i = 0; i < idx.length; i++) {
      if (day[i] > from && day[i] <= to && visible[idx[i]] === 0) {
        visible[idx[i]] = 1;
        shown++;
      }
    }
  }
  return shown;
}

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

  replay(pk, anchor, shard, day);
  const shown =
    windowStart === null
      ? (visible.fill(1), zoneCount)
      : markMoved(visible, spans, windowStart, day);

  post({ type: "state", token, day, shown, pk, visible }, [pk.buffer, visible.buffer]);
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (message.type === "init") {
    config = message;
    return;
  }

  show(message).catch((error) =>
    post({ type: "error", token: message.token, message: String(error?.message ?? error) }),
  );
};
