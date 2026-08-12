"use client";

/**
 * What a flashpoint did to the bots inside its circle.
 *
 * Two groups: the zones the game's own leaderboard named on the flashpoint's days,
 * and every other zone within the same 30 miles. The second answers the question
 * the first cannot — did the fight pull its neighborhood down with it, or was it
 * contained?
 *
 * **Every figure says what it is in words.** Three signed numbers under the
 * headings "before", "during" and "after" is a table only the person who wrote it
 * can read: a reader has to guess what is being counted, over how long, and which
 * direction is which. Each cell here names its span and its unit, and the
 * comparison is spelled out as a sentence rather than left as a bare multiplier.
 *
 * Per-day rates carry the comparison because a one-day event against a 28-day
 * baseline is not a fair comparison raw. Marquette's reported zones lose 712 times
 * their usual daily rate and the zones around them 26 times theirs; those two
 * multiples are the finding, and the raw totals alone bury it.
 */

import { exactNumber } from "./StatsPanel";
import { netOver, type Flashpoint, type ImpactSeries } from "@/lib/flashpoints";

/** Signed and exact: a bot figure that has been rounded cannot be reconciled. */
const signed = (value: number): string =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${exactNumber(value)}`;

/** "gaining" / "losing", so the sign is not the only thing carrying direction. */
const way = (value: number): string => (value > 0 ? "gaining" : value < 0 ? "losing" : "holding");

/**
 * The daily rate, in words, or nothing when the span is one day.
 *
 * A one-day total *is* its own daily rate, and printing the same fourteen digits
 * twice under each other reads as two findings.
 */
function rate(value: number, days: number): string {
  if (days === 1) return "in one day";
  return `${way(value)} ${exactNumber(Math.round(value / days))} a day`;
}

function Cell({
  heading,
  value,
  note,
  strong = false,
  accent,
}: {
  heading: string;
  value: string;
  note: string;
  strong?: boolean;
  accent?: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 2 }}>
        {heading}
      </div>
      <div
        className="tabular"
        style={{ fontSize: strong ? 15 : 13, fontWeight: strong ? 600 : 500, color: accent }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 1 }}>{note}</div>
    </div>
  );
}

function Group({
  label,
  zones,
  before,
  during,
  after,
  boardDays,
  baselineDays,
  accent,
}: {
  label: string;
  zones: number;
  before: number;
  during: number;
  after: number;
  boardDays: number;
  baselineDays: number;
  accent?: string;
}) {
  const baselineRate = before / baselineDays;
  const duringRate = during / boardDays;
  // Only meaningful when the baseline is not itself ~zero, and only interesting
  // when the two run the same way. A sign flip is the more legible statement.
  const multiple =
    Math.abs(baselineRate) > 1000 && Math.sign(duringRate) === Math.sign(baselineRate)
      ? Math.abs(duringRate / baselineRate)
      : null;
  const flipped = Math.sign(duringRate) !== Math.sign(baselineRate) && baselineRate !== 0;
  const dayWord = boardDays === 1 ? "on the day" : `over the ${boardDays} days`;

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ marginBottom: 6 }}>
        <span style={{ color: accent ?? "var(--text)" }}>
          {exactNumber(zones)} {zones === 1 ? "zone" : "zones"}
        </span>{" "}
        <span style={{ color: "var(--text-dim)" }}>{label}</span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: "10px 16px",
        }}
      >
        <Cell
          heading={`${baselineDays} days before`}
          value={signed(before)}
          note={rate(before, baselineDays)}
        />
        <Cell
          heading={dayWord}
          value={signed(during)}
          note={rate(during, boardDays)}
          strong
          accent={accent}
        />
        <Cell
          heading={`${baselineDays} days after`}
          value={signed(after)}
          note={rate(after, baselineDays)}
        />
      </div>
      {(multiple !== null || flipped) && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>
          {flipped
            ? `They were ${way(before)} bots before, and ${way(during)} them ${dayWord}.`
            : `${multiple!.toFixed(multiple! >= 10 ? 0 : 1)}× the rate they were ${way(before)} bots before.`}
        </div>
      )}
    </div>
  );
}

/** Amber, as everywhere else a flashpoint marks itself. Not a faction color. */
const BOARD_ACCENT = "rgb(255, 200, 87)";

export function FlashpointImpact({
  flashpoint,
  series,
  compact = false,
}: {
  flashpoint: Flashpoint;
  series: ImpactSeries | null;
  compact?: boolean;
}) {
  const boardDays = flashpoint.boardEnd - flashpoint.boardStart + 1;
  const baselineDays = Math.max(1, flashpoint.boardStart - flashpoint.runStart);

  return (
    <div style={{ padding: compact ? "0 16px 16px" : "12px 16px" }}>
      {/* Capped, and not stretched across the window. The figures are a paragraph's
          worth of reading; spread over 1,400 px the three columns of one row are so
          far apart they stop reading as a row at all. */}
      <div style={{ maxWidth: 1180 }}>
        <div className="eyebrow" style={{ color: BOARD_ACCENT }}>
          {flashpoint.label}
        </div>
        <div style={{ fontSize: 12, margin: "4px 0 2px", lineHeight: 1.45 }}>
          {flashpoint.blurb}
        </div>

        {!flashpoint.changelogCovered ? (
          /* Absence and zero are different answers, and a flat line at zero reads as
             a calm neighborhood. Six of the ten flashpoints predate usable coverage:
             the record before late 2018 is a thin stream of first sightings and 2019
             is the collection gap. */
          <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5, marginTop: 8 }}>
            The changelog holds no events for these zones in this window. The battle
            reports say the fight happened; the event stream has no rows for it.
            Anything drawn here would be an artifact of collection, not history.
          </div>
        ) : !series ? (
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>Reading…</div>
        ) : (
          <>
            {/* Says what is being counted before any number appears. Net bots, in a
                30-mile circle, split into the zones the game reported and the rest. */}
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>
              Bots gained and lost inside 30 miles of here, counted separately for the
              zones the game reported and for everything around them.
            </div>
            {/* The two groups side by side where there is room, which is the whole
                comparison: what the fight did, against what happened around it. Two
                stacked blocks put the second one below the fold on a laptop and take
                the map's height with them. */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
                gap: "0 40px",
              }}
            >
              <Group
                label="the game reported fighting in"
                accent={BOARD_ACCENT}
                zones={flashpoint.boardIdx.length}
                before={netOver(series.board, series.firstDay, flashpoint.runStart, flashpoint.boardStart - 1)}
                during={netOver(series.board, series.firstDay, flashpoint.boardStart, flashpoint.boardEnd)}
                after={netOver(series.board, series.firstDay, flashpoint.boardEnd + 1, flashpoint.runEnd)}
                boardDays={boardDays}
                baselineDays={baselineDays}
              />
              <Group
                label="around them, inside the same 30 miles"
                zones={flashpoint.zonesInCircle - flashpoint.boardIdx.length}
                before={netOver(series.neighbors, series.firstDay, flashpoint.runStart, flashpoint.boardStart - 1)}
                during={netOver(series.neighbors, series.firstDay, flashpoint.boardStart, flashpoint.boardEnd)}
                after={netOver(series.neighbors, series.firstDay, flashpoint.boardEnd + 1, flashpoint.runEnd)}
                boardDays={boardDays}
                baselineDays={baselineDays}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
