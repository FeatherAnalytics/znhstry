/**
 * The contract between the page and the display worker.
 *
 * Types only, so importing this from the main bundle pulls in no worker code.
 */

import type { ShardEntry } from "./format";

export interface DisplayMeta {
  path: string;
  magnitude_steps: number;
  /** State at the start of a year. Absent for the first year in the record. */
  anchors: ShardEntry[];
  /** One row per zone-day with any event, ordered (idx, day). */
  shards: ShardEntry[];
  anchor_bytes: number;
  shard_bytes: number;
}

export interface InitMessage {
  type: "init";
  base: string;
  epoch: string;
  zoneCount: number;
  display: DisplayMeta;
}

/**
 * Ask for the world on `day`.
 *
 * `pk` and `visible` are lent to the worker and come back filled. Buffers make
 * the round trip rather than being reallocated because playback asks eight
 * times a second and each pair is 5.4 MB - allocating them per step is 43 MB/s
 * of garbage for no reason.
 *
 * `windowStart` non-null means Change: the worker also marks invisible every
 * zone with no event in `(windowStart, day]`. It does not need a second state
 * to do that, because "did this zone move" is a question about whether rows
 * exist, not about comparing two snapshots.
 */
export interface ShowMessage {
  type: "show";
  token: number;
  day: number;
  windowStart: number | null;
  pk: Uint8Array | null;
  visible: Uint8Array | null;
  /**
   * Also report which zones changed faction *on* `day`.
   *
   * Off unless asked for, so the ordinary path pays nothing. The answer comes
   * back as a short list rather than a 2.68M-wide mask: a busy day is about
   * 1,000 zones and the worst in the record is 10,449, so scanning a dense array
   * on the main thread would cost more than the whole rest of the frame.
   */
  flips?: boolean;
}

/**
 * Tell the worker which zone sits in which render slot.
 *
 * Slots are handed out in tile arrival order and a tile is always one
 * contiguous run of them, so this is only ever an append: `idx[k]` is the zone
 * at slot `from + k`. Sent per tile - about 64 KB a message, transferred - and
 * never as one 10.7 MB array, because early tiles must reach the worker before
 * it answers anything.
 *
 * The worker needs it because `pk` and `visible` go back in slot order. Message
 * delivery is ordered, so a `permute` posted before a `show` is applied before
 * it, and the worker can never answer using a permutation older than the
 * geometry the page is about to draw.
 */
export interface PermuteMessage {
  type: "permute";
  from: number;
  idx: Int32Array;
}

export type WorkerRequest = InitMessage | ShowMessage | PermuteMessage;

export interface StateMessage {
  type: "state";
  token: number;
  day: number;
  /** Zones drawn, after a change window has hidden the ones that stood still. */
  shown: number;
  /**
   * Zones holding bots on `day`.
   *
   * Counted here rather than by the panel because the worker is already walking
   * every byte and the main thread was not: the panel's own pass read `pk` and
   * `visible` through the slot indirection, which is a cache miss per zone and
   * measured 10.8% of all CPU during playback. Sequential, off-thread, it is
   * free. Only the unfiltered count - an area selection is the page's own mask
   * and the worker knows nothing about it.
   */
  held: number;
  /**
   * Both **by slot**, not by idx - see `ZoneDisplay`.
   *
   * Only the slots the worker has been told about are written; the tail is left
   * alone, and the page never reads past `geometry.count`.
   */
  pk: Uint8Array;
  visible: Uint8Array;
  /**
   * Zones whose leading faction changed on `day`, or null if none were asked
   * for. `from`/`to` are faction ids, 0 meaning empty - so a capture off an
   * empty zone and a zone fought down to nothing are both in here and the
   * reader decides whether they count.
   *
   * Derived from the same bytes the map is coloured with, in the same pass, so
   * a mark can never appear on a dot that did not change colour.
   */
  flips: { idx: Uint32Array; from: Uint8Array; to: Uint8Array } | null;
}

export interface ErrorMessage {
  type: "error";
  token: number;
  message: string;
}

export type WorkerResponse = StateMessage | ErrorMessage;
