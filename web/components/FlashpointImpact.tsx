"use client";

/**
 * What a flashpoint did to the bots inside its circle.
 *
 * Two groups: the zones that were on the leaderboard during the flashpoint's own
 * days, and every other zone within the same radius. The second answers the
 * question the first cannot — did the fight pull its neighborhood down with it,
 * or was it contained?
 *
 * Per-day rates sit beside the totals because a one-day window against a 28-day
 * baseline is not a fair comparison raw. Marquette's board zones lose 712 times
 * their baseline daily rate and its neighbors 26 times theirs; those two multiples
 * are the finding, and the raw totals alone bury it.
 */

import { compactNumber } from "./StatsPanel";
import { netOver, type Flashpoint, type ImpactSeries } from "@/lib/flashpoints";

const signed = (value: number): string =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${compactNumber(Math.abs(value))}`;

function Row({
  label,
  zones,
  before,
  during,
  after,
  boardDays,
  baselineDays,
}: {
  label: string;
  zones: number;
  before: number;
  during: number;
  after: number;
  boardDays: number;
  baselineDays: number;
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

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ flex: 1, color: "var(--text-dim)" }}>{label}</span>
        <span className="tabular" style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {compactNumber(zones)} {zones === 1 ? "zone" : "zones"}
        </span>
      </div>
      <div
        className="tabular"
        style={{ display: "flex", gap: 10, fontSize: 11, marginTop: 3 }}
      >
        <span style={{ flex: 1, color: "var(--text-dim)" }}>{signed(before)} before</span>
        <span style={{ flex: 1, fontWeight: 600 }}>{signed(during)} during</span>
        <span style={{ flex: 1, color: "var(--text-dim)" }}>{signed(after)} after</span>
      </div>
      {(multiple !== null || flipped) && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
          {flipped
            ? `${signed(Math.round(baselineRate))}/day before, ${signed(Math.round(duringRate))}/day during`
            : `${multiple!.toFixed(multiple! >= 10 ? 0 : 1)}× its own baseline rate`}
        </div>
      )}
    </div>
  );
}

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
      <div className="eyebrow">{flashpoint.label}</div>
      <div style={{ color: "var(--text-dim)", fontSize: 11, margin: "4px 0 10px" }}>
        {flashpoint.blurb}
      </div>

      {!flashpoint.changelogCovered ? (
        /* Absence and zero are different answers, and a flat line at zero reads as
           a calm neighborhood. Six of the ten flashpoints predate usable coverage:
           the record before late 2018 is a thin stream of first sightings and 2019
           is the collection gap. */
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
          The changelog holds no events for these zones in this window. The battle
          reports say the fight happened; the event stream has no rows for it.
          Anything drawn here would be an artifact of collection, not history.
        </div>
      ) : !series ? (
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Reading…</div>
      ) : (
        <>
          <Row
            label="On the board"
            zones={flashpoint.boardIdx.length}
            before={netOver(series.board, series.firstDay, flashpoint.runStart, flashpoint.boardStart - 1)}
            during={netOver(series.board, series.firstDay, flashpoint.boardStart, flashpoint.boardEnd)}
            after={netOver(series.board, series.firstDay, flashpoint.boardEnd + 1, flashpoint.runEnd)}
            boardDays={boardDays}
            baselineDays={baselineDays}
          />
          <Row
            label="Neighbors within 30 miles"
            zones={flashpoint.zonesInCircle - flashpoint.boardIdx.length}
            before={netOver(series.neighbors, series.firstDay, flashpoint.runStart, flashpoint.boardStart - 1)}
            during={netOver(series.neighbors, series.firstDay, flashpoint.boardStart, flashpoint.boardEnd)}
            after={netOver(series.neighbors, series.firstDay, flashpoint.boardEnd + 1, flashpoint.runEnd)}
            boardDays={boardDays}
            baselineDays={baselineDays}
          />
        </>
      )}
    </div>
  );
}
