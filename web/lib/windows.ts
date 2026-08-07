/**
 * What the map is being asked.
 *
 * One row of mutually exclusive choices, not a window plus a mode toggle:
 *
 *   Current   where things stand right now. Every zone holding bots, sized by
 *             how many. No window involved.
 *   a window  what *moved* over that span. Everything static is hidden.
 *
 * These are two different questions, and pairing a window with a Standings /
 * Change toggle made that hard to see: "Standings + Week" quietly ignored the
 * week, so two of the twelve combinations said the same thing and one of them
 * looked like it was answering a question it wasn't.
 *
 * Colour always means the same thing - the faction with the most bots in the
 * zone on the snapshot date. The view only ever decides which zones are drawn.
 */

export const WINDOWS = [
  { key: "day", label: "Day", days: 1 },
  { key: "week", label: "Week", days: 7 },
  { key: "month", label: "Month", days: 30 },
  { key: "quarter", label: "Quarter", days: 91 },
  { key: "year", label: "Year", days: 365 },
  { key: "all", label: "All time", days: Infinity },
] as const;

export type WindowKey = (typeof WINDOWS)[number]["key"];
export type ReadMode = "state" | "change";

/** "current", or one of the windows. What the picker actually selects. */
export type ViewKey = "current" | WindowKey;

export const VIEWS: { key: ViewKey; label: string; title: string }[] = [
  {
    key: "current",
    label: "Current",
    title: "Where things stand now: every zone holding bots, sized by how many",
  },
  ...WINDOWS.map((w) => ({
    key: w.key as ViewKey,
    label: w.label,
    title: `Zones that saw any activity in the last ${w.label.toLowerCase()}`,
  })),
];

export const isWindow = (view: ViewKey): view is WindowKey => view !== "current";

/** Current reads levels; a window reads what moved across it. */
export const readModeOf = (view: ViewKey): ReadMode =>
  view === "current" ? "state" : "change";

/**
 * The span the chart plots.
 *
 * Current has no window of its own, so it plots the whole record - the full
 * growth curve is the context for "where do things stand".
 */
export const chartSpanOf = (view: ViewKey): WindowKey =>
  view === "current" ? "all" : view;

export function windowDays(key: WindowKey): number {
  return WINDOWS.find((w) => w.key === key)!.days;
}

export function windowLabel(key: WindowKey): string {
  return WINDOWS.find((w) => w.key === key)!.label;
}

/** "in the last week", "over all time" - reads in a sentence. */
export function windowPhrase(key: WindowKey): string {
  return key === "all" ? "over all time" : `in the last ${windowLabel(key).toLowerCase()}`;
}

/** The day a window starts, clamped to the beginning of the record. */
export function windowStart(key: WindowKey, end: number, min: number): number {
  const span = windowDays(key);
  return span === Infinity ? min : Math.max(min, end - span);
}
