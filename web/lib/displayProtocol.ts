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
}

export type WorkerRequest = InitMessage | ShowMessage;

export interface StateMessage {
  type: "state";
  token: number;
  day: number;
  /** Zones drawn, after a change window has hidden the ones that stood still. */
  shown: number;
  pk: Uint8Array;
  visible: Uint8Array;
}

export interface ErrorMessage {
  type: "error";
  token: number;
  message: string;
}

export type WorkerResponse = StateMessage | ErrorMessage;
