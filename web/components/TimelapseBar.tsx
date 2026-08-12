"use client";

import { dateToDay, dayToDate } from "@/lib/format";
import type { Backdrop } from "@/lib/timelapse";
import type { Flashpoint } from "@/lib/flashpoints";

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
  /** Curated days worth watching, or empty when the export carries none. */
  flashpoints: Flashpoint[];
  activeFlashpoint: string | null;
  onFlashpoint: (flashpoint: Flashpoint | null) => void;
}

/**
 * Amber, the color the recurrence rings and the board marks already use.
 *
 * Being the flashpoint's day is not a faction fact, so it must not borrow red,
 * green or purple - the same rule the MAZ rings follow.
 */
const BOARD_ACCENT = "rgb(255, 200, 87)";

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
  flashpoints,
  activeFlashpoint,
  onFlashpoint,
}: Props) {
  const chosen = flashpoints.find((f) => f.id === activeFlashpoint) ?? null;
  /** The playhead is standing on the days the flashpoint is named for. */
  const onBoardDay =
    chosen !== null && day !== null && day >= chosen.boardStart && day <= chosen.boardEnd;
  // A picked flashpoint suppresses the period caveat rather than replacing it: the
  // impact panel above already carries the flashpoint's own note beside its label,
  // and the same sentence twice on one screen reads as two different claims.
  const caveat = chosen
    ? null
    : activePeriod
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

        {/* Fixed width, not just tabular numerals. The digits are equal-width
            already; the month is not - "MAY" and "AUG" differ by a few pixels
            in the display face, which was enough to resize the scrubber on the
            frames that crossed a month boundary. Reserving the space is the only
            thing that holds the track still. */}
        <span
          className="display tabular"
          style={{
            fontSize: 17,
            whiteSpace: "nowrap",
            width: 152,
            flexShrink: 0,
            // The date itself carries the state, so the fact that this is the day
            // the flashpoint names cannot be missed while watching the map.
            color: onBoardDay ? BOARD_ACCENT : undefined,
          }}
        >
          {day !== null
            ? dayToDate(epoch, day).toLocaleDateString("en-US", {
                day: "2-digit",
                month: "short",
                year: "numeric",
                // A day is a UTC date. Rendering it in the reader's own zone puts
                // the playhead a day behind the panel everywhere west of UTC.
                timeZone: "UTC",
              })
            : "—"}
        </span>

        {/* Reserved only while a flashpoint is loaded, and fixed then, for the same
            reason the date is: appearing beside the track would resize it on the
            frames that matter most. With no flashpoint there is nothing to reserve
            for, and on a 390 px screen the track needs every pixel. */}
        <span
          className="eyebrow"
          style={{
            width: chosen ? 108 : 0,
            flexShrink: 0,
            fontSize: 10,
            color: BOARD_ACCENT,
            visibility: onBoardDay ? "visible" : "hidden",
          }}
        >
          {chosen && chosen.boardEnd > chosen.boardStart ? "Flashpoint days" : "Flashpoint day"}
        </span>

        {/* Nothing that changes width may sit after this. The counts used to,
            and every extra digit resized the scrubber mid-playback - the track
            visibly breathing while the numbers climbed. They live on the row
            below now, last, where nothing follows them. */}
        <input
          type="range"
          min={bounds?.min ?? 0}
          max={bounds?.max ?? 1}
          value={day ?? 0}
          onChange={(e) => onDay(Number(e.target.value))}
          aria-label="Date"
          style={{ flex: 1, minWidth: 120 }}
        />
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
            aria-pressed={activePeriod === p.label && !chosen}
            style={chip(activePeriod === p.label && !chosen)}
          >
            {p.label}
          </button>
        ))}

        {/* Flashpoints are a different kind of choice from a period - a place as
            well as a span - so the select says so rather than sitting among the
            chips as an eleventh one. */}
        {flashpoints.length > 0 && (
          <select
            value={activeFlashpoint ?? ""}
            onChange={(e) =>
              onFlashpoint(flashpoints.find((f) => f.id === e.target.value) ?? null)
            }
            aria-label="Fly to a flashpoint"
            // Wants 260 px, because clipping the date off the end leaves two
            // flashpoints in the same place indistinguishable - but it yields on a
            // narrow screen rather than overflowing the row and clipping the label
            // from the *left*, which is worse.
            style={{ ...control, flex: "1 1 260px", minWidth: 0 }}
          >
            <option value="">Flashpoint…</option>
            {flashpoints.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label} · {iso(epoch, f.boardStart).slice(0, 10)}
              </option>
            ))}
          </select>
        )}

        <span
          className="eyebrow tabular"
          style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}
        >
          {/* The span, and how many zones changed hands on the day on screen. No
              count of the amber rings: a MAZ ring is a trailing 30-day window, so
              the number rises and falls with the window rather than with anything
              happening, and it answers no question the rings do not answer better. */}
          {bounds ? `${(bounds.max - bounds.min).toLocaleString()} days · ` : ""}
          {flips.toLocaleString()} changed hands
          {backdrop === "cumulative" ? ` · ${claimed.toLocaleString()} claimed` : ""}
        </span>
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
