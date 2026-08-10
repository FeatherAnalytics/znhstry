/**
 * MAZ — Most Active Zones — for the display prototype.
 *
 * A MAZ is not "a battle happened here". QONQR publishes a fixed number of
 * reports a day from its Most Active Zones page, so a row means *this zone was
 * among the most active in the world that day*. Exactly ten on most days.
 *
 * Which is the whole design problem this module exists to explore: **ten dots a
 * day against 2.68M zones**. A one-day point flash is not a map, it is a rounding
 * error, so the encodings below all trade some immediacy for enough marks on
 * screen to read as a pattern.
 *
 * Everything here is derived on the fly from one 0.69 MB payload. No second
 * fetch, no precomputed rolling windows in the export — a window is at most 90
 * days of ~10 reports, so recomputing it per frame is under a thousand
 * iterations and settling the encoding by export would be settling it before we
 * have looked at it.
 */

import { dataUrl } from "./format";

export interface MazData {
  dayEpoch: string;
  dayMin: number;
  dayMax: number;
  /** Per zone, in first-appearance order. */
  zoneId: Int32Array;
  name: string[];
  lat: Float32Array;
  lon: Float32Array;
  /** Per report, sorted by day. */
  reportZone: Int32Array;
  reportDay: Int32Array;
  players: Int32Array;
  launches: Int32Array;
  botsLaunched: Int32Array;
  botsKilled: Int32Array;
  botsLost: Int32Array;
  /**
   * `dayOffset[d - dayMin]` is the first report index on or after day `d`, so a
   * window is two lookups and a contiguous scan. Length is the span plus one, so
   * the end of the last day is addressable.
   */
  dayOffset: Int32Array;
  reportCount: number;
  zoneCount: number;
}

interface RawMaz {
  day_epoch: string;
  day_min: number;
  day_max: number;
  zones: { zone_id: number[]; name: string[]; lat: number[]; lon: number[] };
  reports: {
    zone: number[];
    day: number[];
    players: number[];
    launches: number[];
    bots_launched: number[];
    bots_killed: number[];
    bots_lost: number[];
  };
}

export async function loadMaz(base: string): Promise<MazData> {
  const response = await fetch(dataUrl(`${base}/maz_proto.json.br`));
  if (!response.ok) throw new Error(`${response.status} for maz_proto.json.br`);
  const raw: RawMaz = await response.json();

  const day = Int32Array.from(raw.reports.day);
  const span = raw.day_max - raw.day_min + 1;

  // One pass, walking a cursor rather than searching: the reports are already
  // sorted by day, which is the only reason this is linear.
  const dayOffset = new Int32Array(span + 1);
  let cursor = 0;
  for (let d = 0; d < span; d++) {
    while (cursor < day.length && day[cursor] < raw.day_min + d) cursor++;
    dayOffset[d] = cursor;
  }
  dayOffset[span] = day.length;

  return {
    dayEpoch: raw.day_epoch,
    dayMin: raw.day_min,
    dayMax: raw.day_max,
    zoneId: Int32Array.from(raw.zones.zone_id),
    name: raw.zones.name,
    lat: Float32Array.from(raw.zones.lat),
    lon: Float32Array.from(raw.zones.lon),
    reportZone: Int32Array.from(raw.reports.zone),
    reportDay: day,
    players: Int32Array.from(raw.reports.players),
    launches: Int32Array.from(raw.reports.launches),
    botsLaunched: Int32Array.from(raw.reports.bots_launched),
    botsKilled: Int32Array.from(raw.reports.bots_killed),
    botsLost: Int32Array.from(raw.reports.bots_lost),
    dayOffset,
    reportCount: day.length,
    zoneCount: raw.zones.zone_id.length,
  };
}

// --- the candidate encodings ---------------------------------------------

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
  /** lon, lat pairs. */
  positions: Float32Array;
  /** 0..1. Drives alpha. */
  intensity: Float32Array;
  /** 0..1. Drives radius. */
  weight: Float32Array;
  /** Zone index into `MazData`. */
  zone: Int32Array;
  /** Marks whose own day is the playhead - the genuinely new ones. */
  fresh: Uint8Array;
}

const EMPTY: MazMarks = {
  count: 0,
  positions: new Float32Array(0),
  intensity: new Float32Array(0),
  weight: new Float32Array(0),
  zone: new Int32Array(0),
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
  if (day < data.dayMin || day > data.dayMax) return EMPTY;

  const from = Math.max(data.dayMin, day - window);
  const start = data.dayOffset[from - data.dayMin];
  const end = data.dayOffset[day - data.dayMin + 1];
  if (end <= start) return EMPTY;

  // Zone index -> slot in the output arrays. A Map rather than an 11,723-wide
  // array so the cost is the window's size, not the zone table's.
  const slotOf = new Map<number, number>();
  const zone = new Int32Array(end - start);
  const appearances = new Float64Array(end - start);
  const fresh = new Uint8Array(end - start);
  let count = 0;

  for (let r = start; r < end; r++) {
    const z = data.reportZone[r];
    let slot = slotOf.get(z);
    if (slot === undefined) {
      slot = count++;
      slotOf.set(z, slot);
      zone[slot] = z;
    }
    if (data.reportDay[r] === day) fresh[slot] = 1;
    appearances[slot] += 1;
  }

  const scale = 1 / Math.log1p(RECURRENCE_REFERENCE);
  const positions = new Float32Array(count * 2);
  const intensity = new Float32Array(count);
  const weight = new Float32Array(count);
  const outZone = new Int32Array(count);
  const outFresh = new Uint8Array(count);

  for (let s = 0; s < count; s++) {
    const value = Math.min(1, Math.log1p(appearances[s]) * scale);
    const z = zone[s];
    positions[s * 2] = data.lon[z];
    positions[s * 2 + 1] = data.lat[z];
    intensity[s] = value;
    weight[s] = value;
    outZone[s] = z;
    outFresh[s] = fresh[s];
  }

  return { count, positions, intensity, weight, zone: outZone, fresh: outFresh };
}
