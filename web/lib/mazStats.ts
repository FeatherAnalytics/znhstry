/**
 * The per-report MAZ metrics, and the distribution math over them.
 *
 * `maz_stats.bin.br` is row-aligned with `maz.bin.br` and carries **no key
 * columns at all** - row *i* describes report *i*, and the zone and the day come
 * from the other file. That is the frugal shape and it is only safe while both
 * are read together, so they are loaded by one function here rather than
 * separately by whoever needs them.
 *
 * **This covers mapped MAZ only.** The export builds it from `fct_zone_battles`,
 * which excludes the 15,837 tournament reports because they have no coordinates.
 * Tournament zones carry the heaviest fighting in the game - a median 36 active
 * players against 6 - so any figure derived from here describes the mapped world
 * and must say so.
 *
 * Everything below the loader is pure and takes plain arrays, because the point
 * of these functions is to be moved into the main app once a chart earns its
 * place there.
 */

import { loadShard } from "./format";
import { loadMaz, type MazData, type MazEntry } from "./maz";

/** Row `i` describes report `i` of the accompanying `MazData`. */
export interface MazStats {
  reports: MazData;
  players: Uint16Array;
  launches: Int32Array;
  botsLaunched: Int32Array;
  botsKilled: Int32Array;
  botsLost: Int32Array;
}

export async function loadMazStats(base: string, entry: MazEntry): Promise<MazStats> {
  if (!entry.stats) throw new Error("meta.maz carries no stats shard");

  const [reports, columns] = await Promise.all([
    loadMaz(base, entry),
    loadShard(base, entry.stats),
  ]);

  // The row alignment is the whole contract and nothing downstream can detect a
  // break in it - both files parse, both hold plausible numbers, and the only
  // symptom is one zone's launches attributed to another.
  if (entry.stats.rows !== reports.reportCount) {
    throw new Error(
      `maz_stats has ${entry.stats.rows} rows against ${reports.reportCount} reports`,
    );
  }

  return {
    reports,
    players: columns.players as Uint16Array,
    launches: columns.launches as Int32Array,
    botsLaunched: columns.bots_launched as Int32Array,
    botsKilled: columns.bots_killed as Int32Array,
    botsLost: columns.bots_lost as Int32Array,
  };
}

// --- distributions ------------------------------------------------------------

export interface Summary {
  count: number;
  min: number;
  median: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
}

/**
 * Order statistics, not a mean and a standard deviation.
 *
 * Every quantity here is heavy-tailed: the biggest single report is orders of
 * magnitude above the median, so a mean sits somewhere in the empty space
 * between the bulk and the tail and describes neither. The mean is returned
 * anyway, to be shown *next to* the median where the gap between them is the
 * point.
 */
export function summarize(values: ArrayLike<number>): Summary {
  if (values.length === 0) {
    return { count: 0, min: 0, median: 0, p90: 0, p99: 0, max: 0, mean: 0 };
  }

  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

  let total = 0;
  for (let i = 0; i < sorted.length; i++) total += sorted[i];

  return {
    count: sorted.length,
    min: sorted[0],
    median: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    mean: total / sorted.length,
  };
}

export interface Bin {
  /** Inclusive lower edge. */
  lo: number;
  /** Exclusive upper edge. */
  hi: number;
  count: number;
}

/**
 * Logarithmic bins, because a linear histogram of any of these is one tall bar
 * and a flat line.
 *
 * Launches on a single report run from single digits to five figures. Linear
 * bins wide enough to reach the maximum put 99% of the mass in the first one,
 * which draws the tail correctly and says nothing about the bulk - the shape
 * worth seeing is in the first two decades.
 *
 * Zero and negative values fall in the first bin rather than being dropped: a
 * report with no launches is real data, and silently discarding rows makes the
 * count under the chart disagree with the count above it.
 */
export function logBins(values: ArrayLike<number>, binsPerDecade = 6): Bin[] {
  let max = 1;
  for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];

  const count = Math.max(1, Math.ceil(Math.log10(max) * binsPerDecade) + 1);
  const edge = (b: number) => 10 ** (b / binsPerDecade);

  const bins: Bin[] = Array.from({ length: count }, (_, b) => ({
    lo: b === 0 ? 0 : edge(b),
    hi: edge(b + 1),
    count: 0,
  }));

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const b = value <= 1 ? 0 : Math.min(count - 1, Math.floor(Math.log10(value) * binsPerDecade));
    bins[b].count++;
  }
  return bins;
}

export interface DailySeries {
  /** Days since the export epoch, ascending, only days that carry reports. */
  day: Int32Array;
  value: Float64Array;
  /** Reports behind each day's value - the denominator for a per-report rate. */
  reports: Int32Array;
}

/**
 * One value per MAZ day, summed over that day's reports.
 *
 * A raw daily sum mixes days of different sizes: the top ten is exactly ten
 * reports on 3,452 of 4,599 days but runs to fourteen on a few, so `reports`
 * comes back alongside the total and a per-report rate is one division away.
 */
export function dailyTotals(stats: MazStats, values: ArrayLike<number>): DailySeries {
  const { dayMin, dayMax, dayOffset } = stats.reports;
  const span = dayMax - dayMin + 1;

  const days: number[] = [];
  const totals: number[] = [];
  const counts: number[] = [];

  for (let d = 0; d < span; d++) {
    const start = dayOffset[d];
    const end = dayOffset[d + 1];
    if (end <= start) continue;

    let total = 0;
    for (let r = start; r < end; r++) total += values[r];

    days.push(dayMin + d);
    totals.push(total);
    counts.push(end - start);
  }

  return {
    day: Int32Array.from(days),
    value: Float64Array.from(totals),
    reports: Int32Array.from(counts),
  };
}

/** How many times each zone appears, as `idx -> appearances`. */
export function appearancesByZone(stats: MazStats): Map<number, number> {
  const counts = new Map<number, number>();
  const { reportIdx, reportCount } = stats.reports;
  for (let r = 0; r < reportCount; r++) {
    const idx = reportIdx[r];
    counts.set(idx, (counts.get(idx) ?? 0) + 1);
  }
  return counts;
}
