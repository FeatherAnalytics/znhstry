"use client";

import { dateToDay, dayToDate } from "@/lib/format";
import type { Backdrop } from "@/lib/timelapse";

/**
 * Named spans worth watching, as ISO dates. `null` is the end of the record on
 * either side; `world` clears the focus, because a preset about a global change
 * should not open inside whatever region was last picked.
 */
export interface Period {
  label: string;
  start: string | null;
  end: string | null;
  world?: boolean;
  /** Shown while the span is active. */
  caveat?: string;
}

export const PERIODS: Period[] = [
  { label: "Whole record", start: null, end: null },
  { label: "MAZ era", start: "2014-01-01", end: null },
  {
    label: "Missile Range Increase",
    start: "2017-04-01",
    end: "2019-12-31",
    world: true,
    /**
     * The wave this shows is real; its cause is not knowable from our data.
     *
     * Over this window 790 zones were witnessed going from empty to held - seen
     * empty beforehand - against 817,344 whose first changelog row of any kind
     * falls inside it, and none of the 790 land before October 2018. Part of the
     * rise is genuine: first sightings step from ~22k a month through April 2017
     * to ~34k from May. Part is not: Watauga was a Most Active Zone in January
     * 2014 and enters the changelog in September 2018.
     */
    caveat:
      "The changelog has no earlier state for this period, so a capture and a new arrival look the same.",
  },
];

const BACKDROPS: { key: Backdrop; label: string; title: string }[] = [
  { key: "daily", label: "Daily", title: "Only zones with an event that day" },
  { key: "all", label: "All zones", title: "Every zone holding bots on that date" },
  {
    key: "cumulative",
    label: "Cumulative",
    title: "Start unclaimed; a zone appears when it changes hands and stays",
  },
];

const control: React.CSSProperties = {
  background: "rgba(14,18,24,0.82)",
  border: "1px solid var(--hairline-bright)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 12,
  padding: "3px 7px",
  colorScheme: "dark",
};

function chip(on: boolean): React.CSSProperties {
  return {
    padding: "3px 9px",
    fontSize: 11,
    border: `1px solid ${on ? "var(--hairline-bright)" : "var(--hairline)"}`,
    background: on ? "var(--hairline)" : "transparent",
    color: on ? "var(--text)" : "var(--text-dim)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

interface Props {
  epoch: string;
  /** The furthest the period controls may reach. */
  outer: { min: number; max: number } | null;
  /** What playback actually runs between. */
  bounds: { min: number; max: number } | null;
  day: number | null;
  onDay: (day: number) => void;
  rangeStart: number | null;
  rangeEnd: number | null;
  onRange: (start: number | null, end: number | null) => void;
  activePeriod: string | null;
  onPeriod: (period: Period) => void;
  backdrop: Backdrop;
  onBackdrop: (backdrop: Backdrop) => void;
  playing: boolean;
  onTogglePlay: () => void;
  marks: number;
  flips: number;
  claimed: number;
}

const iso = (epoch: string, day: number): string =>
  dayToDate(epoch, day).toISOString().slice(0, 10);

export function TimelapseBar({
  epoch,
  outer,
  bounds,
  day,
  onDay,
  rangeStart,
  rangeEnd,
  onRange,
  activePeriod,
  onPeriod,
  backdrop,
  onBackdrop,
  playing,
  onTogglePlay,
  marks,
  flips,
  claimed,
}: Props) {
  const caveat = activePeriod
    ? (PERIODS.find((p) => p.label === activePeriod)?.caveat ?? null)
    : null;
  const toDay = (value: string) =>
    value ? dateToDay(epoch, new Date(`${value}T00:00:00Z`)) : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "10px 14px",
        borderTop: "1px solid var(--hairline)",
        background: "var(--ink-raised)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={onTogglePlay}
          aria-label={playing ? "Pause" : "Play the timelapse"}
          aria-pressed={playing}
          style={{ ...chip(playing), width: 64, textAlign: "center" }}
        >
          {playing ? "❙❙ Pause" : "▶ Play"}
        </button>

        <span className="display tabular" style={{ fontSize: 17, whiteSpace: "nowrap" }}>
          {day !== null
            ? dayToDate(epoch, day).toLocaleDateString("en-US", {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })
            : "—"}
        </span>

        <input
          type="range"
          min={bounds?.min ?? 0}
          max={bounds?.max ?? 1}
          value={day ?? 0}
          onChange={(e) => onDay(Number(e.target.value))}
          aria-label="Date"
          style={{ flex: 1, minWidth: 120 }}
        />

        <span className="eyebrow" style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
          {marks.toLocaleString()} MAZ · {flips.toLocaleString()} flips
          {backdrop === "cumulative" ? ` · ${claimed.toLocaleString()} claimed` : ""}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {BACKDROPS.map((b) => (
          <button
            key={b.key}
            onClick={() => onBackdrop(b.key)}
            title={b.title}
            aria-pressed={backdrop === b.key}
            style={chip(backdrop === b.key)}
          >
            {b.label}
          </button>
        ))}

        <span style={{ width: 12 }} />

        <input
          type="date"
          value={rangeStart !== null ? iso(epoch, rangeStart) : ""}
          min={outer ? iso(epoch, outer.min) : undefined}
          max={outer ? iso(epoch, outer.max) : undefined}
          onChange={(e) => onRange(toDay(e.target.value), rangeEnd)}
          aria-label="From"
          style={control}
        />
        <input
          type="date"
          value={rangeEnd !== null ? iso(epoch, rangeEnd) : ""}
          min={outer ? iso(epoch, outer.min) : undefined}
          max={outer ? iso(epoch, outer.max) : undefined}
          onChange={(e) => onRange(rangeStart, toDay(e.target.value))}
          aria-label="To"
          style={control}
        />

        {PERIODS.map((p) => (
          <button
            key={p.label}
            onClick={() => onPeriod(p)}
            aria-pressed={activePeriod === p.label}
            style={chip(activePeriod === p.label)}
          >
            {p.label}
          </button>
        ))}

        {bounds ? (
          <span className="eyebrow" style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {(bounds.max - bounds.min).toLocaleString()} days
          </span>
        ) : null}
      </div>

      {caveat ? (
        <p
          style={{
            margin: 0,
            fontSize: 11,
            lineHeight: 1.35,
            color: "var(--text-dim)",
            borderLeft: "2px solid var(--hairline-bright)",
            paddingLeft: 8,
          }}
        >
          {caveat}
        </p>
      ) : null}
    </div>
  );
}
