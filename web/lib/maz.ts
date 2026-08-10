/**
 * MAZ — Most Active Zones.
 *
 * A MAZ is not "a battle happened here". QONQR publishes a fixed number of
 * reports a day from its Most Active Zones page, so a row means *this zone was
 * among the most active in the world that day*. Exactly ten on most days.
 *
 * Which is the design problem the ring encoding exists to solve: **ten zones a
 * day against 2.68M**. A one-day mark is not a map, it is a rounding error, so
 * a ring counts appearances over a trailing window instead.
 *
 * The payload is `(idx, day)` and nothing else. Positions come from the geometry
 * the viewer already holds, names from `names/` on hover; shipping either again
 * would be a second copy that can disagree with the first. The reports' launch,
 * player and bot columns are not carried because nothing draws them.
 */

import { loadShard, type ShardEntry } from "./format";

export interface MazEntry extends ShardEntry {
  day_min: number;
  day_max: number;
}

export interface MazData {
  dayMin: number;
  dayMax: number;
  /** Export idx per report, grouped by day. */
  reportIdx: Uint32Array;
  /** Day per report, ascending. */
  reportDay: Uint16Array;
  /**
   * `dayOffset[d - dayMin]` is the first report on or after day `d`, so a
   * window is two lookups and a contiguous scan. One longer than the span, so
   * the end of the last day is addressable.
   */
  dayOffset: Int32Array;
  reportCount: number;
}

export async function loadMaz(base: string, entry: MazEntry): Promise<MazData> {
  const columns = await loadShard(base, entry);
  const reportDay = columns.day as Uint16Array;
  const reportIdx = columns.idx as Uint32Array;
  const span = entry.day_max - entry.day_min + 1;

  // One pass walking a cursor rather than searching per day: the rows are
  // already sorted by day, which is the only reason this is linear.
  const dayOffset = new Int32Array(span + 1);
  let cursor = 0;
  for (let d = 0; d < span; d++) {
    while (cursor < reportDay.length && reportDay[cursor] < entry.day_min + d) cursor++;
    dayOffset[d] = cursor;
  }
  dayOffset[span] = reportDay.length;

  return {
    dayMin: entry.day_min,
    dayMax: entry.day_max,
    reportIdx,
    reportDay,
    dayOffset,
    reportCount: reportDay.length,
  };
}


/**
 * How a MAZ is drawn, and why this and not something else.
 *
 * Brightness is appearances in a trailing window - "this is a chronic hotspot",
 * which is what the heavy tail is about: the top zone appears on 1,286 of 4,599
 * covered days. Size is the same count, on its own scale.
 *
 * Flashing a MAZ on its own day, decaying it over a half-life, and sizing by a
 * consecutive-day streak were all built and compared against this on a real map.
 * A one-day flash is ten dots on a world map and reads as nothing; a streak
 * flickers. They are gone rather than left switchable.
 */
export interface MazMarks {
  count: number;
  /** 0..1. Drives alpha. */
  intensity: Float32Array;
  /** 0..1. Drives radius. */
  weight: Float32Array;
  /** Export idx of the zone the mark belongs to. */
  idx: Uint32Array;
  /** Marks whose own day is the playhead - the genuinely new ones. */
  fresh: Uint8Array;
}

const EMPTY: MazMarks = {
  count: 0,
  intensity: new Float32Array(0),
  weight: new Float32Array(0),
  idx: new Uint32Array(0),
  fresh: new Uint8Array(0),
};

/**
 * Appearances that map to a full-strength mark.
 *
 * Fixed, not the largest value in the frame. Normalizing per frame looked
 * obvious and is wrong for a timelapse: on a quiet day the loudest zone of ten
 * is drawn exactly as loudly as the loudest zone of a hundred-launch war, so a
 * mark's size means a different thing every frame and the whole run shimmers
 * without saying anything. A fixed reference makes two days comparable, which is
 * the only reason to animate them in sequence.
 *
 * Thirty appearances in a window is already a war.
 */
const RECURRENCE_REFERENCE = 30;

/**
 * Marks to draw for `day`, over a trailing `window` of days.
 *
 * `window` is a density dial, not a meaning dial. Measured across sampled dates,
 * the median zone appears once in the window and the 90th percentile about five
 * times, at *every* length from 14 to 180 days. Only the number of marks moves -
 * 60 at 14 days, 114 at 30, 209 at 60, 299 at 90.
 *
 * Accumulated per zone rather than per report, because a zone that appeared
 * three times this week is one mark with a story, not three stacked on the same
 * pixel.
 */
export function marksFor(data: MazData, day: number, window: number): MazMarks {
  if (day < data.dayMin) return EMPTY;

  // Clamped rather than emptied past the newest report. Battle reports are
  // scraped a day behind the changelog, so the map opens on a date MAZ does not
  // reach and the mode would show nothing at all on entry - which reads as a
  // failed load rather than as a one-day lag.
  const until = Math.min(day, data.dayMax);
  const from = Math.max(data.dayMin, until - window);
  const start = data.dayOffset[from - data.dayMin];
  const end = data.dayOffset[until - data.dayMin + 1];
  if (end <= start) return EMPTY;

  // Zone index -> slot in the output arrays. A Map rather than an 11,723-wide
  // array so the cost is the window's size, not the zone table's.
  const slotOf = new Map<number, number>();
  const zoneIdx = new Uint32Array(end - start);
  const appearances = new Float64Array(end - start);
  const fresh = new Uint8Array(end - start);
  let count = 0;

  for (let r = start; r < end; r++) {
    const z = data.reportIdx[r];
    let slot = slotOf.get(z);
    if (slot === undefined) {
      slot = count++;
      slotOf.set(z, slot);
      zoneIdx[slot] = z;
    }
    if (data.reportDay[r] === until) fresh[slot] = 1;
    appearances[slot] += 1;
  }

  const scale = 1 / Math.log1p(RECURRENCE_REFERENCE);
  const intensity = new Float32Array(count);
  const weight = new Float32Array(count);
  const outIdx = new Uint32Array(count);
  const outFresh = new Uint8Array(count);

  for (let s = 0; s < count; s++) {
    const value = Math.min(1, Math.log1p(appearances[s]) * scale);
    intensity[s] = value;
    weight[s] = value;
    outIdx[s] = zoneIdx[s];
    outFresh[s] = fresh[s];
  }

  return { count, intensity, weight, idx: outIdx, fresh: outFresh };
}
