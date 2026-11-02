"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { MultiSeries } from "@/components/charts/MultiSeries";
import { useChartPointer } from "@/components/charts/useChartPointer";
import {
  deriveIntervals,
  formatObs,
  factionColor,
  factionHex,
  compact,
  type MonthPayload,
  type Interval,
} from "./lib";

interface Props {
  faction: string;
  playerName: string;
  month: MonthPayload;
  obsTimestamps: number[];
  onClose: () => void;
}

const PAD = { top: 10, right: 12, bottom: 26, left: 52 };
const WIDTH = 640;
const BAR_HEIGHT = 100;

const section: CSSProperties = {
  padding: "16px 16px 24px",
  borderTop: "1px solid var(--hairline)",
  background: "var(--ink-raised)",
};

function topIntervals(intervals: Interval[], count: number): Interval[] {
  return [...intervals].sort((a, b) => b.perHour - a.perHour).slice(0, count);
}

function GainsBars({ intervals, obsTs, color }: { intervals: Interval[]; obsTs: number[]; color: string }) {
  const n = obsTs.length;
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = BAR_HEIGHT - PAD.top - 10;
  const xMin = obsTs[0];
  const xSpan = Math.max(1, obsTs[n - 1] - xMin);
  const px = (i: number) => PAD.left + ((obsTs[i] - xMin) / xSpan) * plotW;

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const clearHover = useCallback(() => setHoverIdx(null), []);
  const pointer = useChartPointer<SVGSVGElement>((event) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * WIDTH;
    const next = intervals.findIndex((iv) => x <= px(iv.index));
    setHoverIdx(next >= 0 ? next : intervals.length - 1);
  }, clearHover);

  if (!n || intervals.length === 0) return null;

  const maxGain = Math.max(1, ...intervals.map((iv) => iv.gained));
  const top3 = topIntervals(intervals, 3);
  const hovered = hoverIdx !== null ? intervals[hoverIdx] : undefined;

  return (
    <>
    <svg {...pointer} viewBox={`0 0 ${WIDTH} ${BAR_HEIGHT}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Gains per interval">
      {intervals.map((iv) => {
        const x1 = px(iv.prevIndex);
        const x2 = px(iv.index);
        const barH = (iv.gained / maxGain) * plotH;
        const isTop = top3.includes(iv);
        return (
          <g key={iv.index}>
            <rect
              x={x1}
              y={PAD.top + plotH - barH}
              width={Math.max(2, x2 - x1 - 1)}
              height={barH}
              fill={color}
              opacity={iv === hovered ? 1 : isTop ? 0.9 : 0.4}
            />
            {isTop ? (
              <text
                x={(x1 + x2) / 2}
                y={PAD.top + plotH - barH - 3}
                textAnchor="middle"
                fontSize={8}
                fill="var(--text)"
                className="tabular"
              >
                {Math.round(iv.perHour)}/hr
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
    <div className="tabular" style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2, minHeight: 16 }}>
      {hovered ? (
        <>
          {formatObs(obsTs[hovered.prevIndex])} to {formatObs(obsTs[hovered.index])}
          <span style={{ color: "var(--text)", marginLeft: 8 }}>+{compact(hovered.gained)}</span>
          <span style={{ marginLeft: 8 }}>{compact(hovered.perHour)}/hr</span>
        </>
      ) : null}
    </div>
    </>
  );
}

export default function PlayerDetail({ faction, playerName, month, obsTimestamps, onClose }: Props) {
  const data = month.players[faction]?.[playerName];
  const root = useRef<HTMLDivElement>(null);

  // This renders below the whole leaderboard, so without the scroll a click on a
  // name shows no change on screen.
  useEffect(() => {
    root.current?.scrollIntoView({ block: "start" });
  }, [faction, playerName]);

  const intervals = useMemo(
    () => (data ? deriveIntervals(data.launches, obsTimestamps) : []),
    [data, obsTimestamps],
  );

  if (!data) return null;

  const factionTotal = Object.values(month.players[faction] ?? {}).reduce(
    (sum, p) => sum + (p.qredits ?? 0), 0,
  );
  const share = factionTotal > 0 ? ((data.qredits ?? 0) / factionTotal * 100).toFixed(1) : "0";
  const color = factionHex(faction);

  return (
    <div ref={root} style={section}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
        <button type="button" onClick={onClose} style={{ color: "var(--text-dim)", cursor: "pointer", background: "none", border: "none", fontSize: 16 }}>✕</button>
        <span className="display" style={{ fontSize: 16 }}>{playerName}</span>
        <span style={{ color: factionColor(faction) }}>{faction}</span>
        {data.qredits ? (
          <span className="tabular" style={{ color: "var(--text-dim)" }}>
            {compact(data.qredits)} qredits ({share}% of faction)
            {!month.is_finished ? " est." : ""}
          </span>
        ) : null}
      </div>

      <div className="display" style={{ fontSize: 11, marginBottom: 4 }}>Launches</div>
      <MultiSeries x={obsTimestamps} series={[{ label: "Launches", color, values: data.launches }]} title="" labelOf={formatObs} height={180} />

      <div className="display" style={{ fontSize: 11, marginBottom: 4, marginTop: 12 }} title="Launches gained between the first and last observation we hold — see the coverage line for this month's window">Gains per interval</div>
      <GainsBars intervals={intervals} obsTs={obsTimestamps} color={color} />
      <span className="compact-footnote eyebrow" style={{ color: "var(--text-dim)", marginTop: 4, fontSize: 9 }}>
        Gains cover observed hours only
      </span>

      <BadgeMarkers data={data} obsTimestamps={obsTimestamps} />

      <BattleReports playerName={playerName} month={month} />

      <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 12 }}>
        Hourly launch trend, based on observed data. Labels mark the busiest intervals, as launches per hour.
      </div>
    </div>
  );
}

interface Badge { label: string; title: string }

function BadgeMarkers({ data, obsTimestamps }: { data: { tm: (boolean | null)[]; wm: (boolean | null)[] }; obsTimestamps: number[] }) {
  const badges: Badge[] = [];
  for (let i = 0; i < data.tm.length; i++) {
    if (data.tm[i] === true && (i === 0 || data.tm[i - 1] !== true)) {
      badges.push({
        label: `Tournament 1M at ${formatObs(obsTimestamps[i])}`,
        title: "Tournament Million Kills: 1,000,000+ kills in the current tournament (atlantis-gold badge)",
      });
    }
    if (data.wm[i] === true && (i === 0 || data.wm[i - 1] !== true)) {
      badges.push({
        label: `Weekly 1M at ${formatObs(obsTimestamps[i])}`,
        title: "Weekly Million Kills: 1,000,000+ kills this week outside the tournament, weeks start 00:00 UTC Sunday (gold-star badge)",
      });
    }
  }
  if (badges.length === 0) return null;
  return (
    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>
      {badges.map((b) => <div key={b.label} title={b.title}>★ {b.label}</div>)}
    </div>
  );
}

const btCell: CSSProperties = { padding: "12px 10px", borderBottom: "1px solid var(--hairline)", whiteSpace: "nowrap" as const };
const btDateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function BattleReports({ playerName, month }: { playerName: string; month: MonthPayload }) {
  if (!month.battles) return null;

  const rows: { day: string; zone: string; rank: number; launches: number; killed: number; lost: number }[] = [];
  for (const [day, zones] of Object.entries(month.battles)) {
    for (const [zone, players] of Object.entries(zones)) {
      const idx = players.findIndex((p) => p[0] === playerName);
      if (idx >= 0) {
        const [, launches, killed, lost] = players[idx];
        rows.push({ day, zone, rank: idx + 1, launches, killed, lost });
      }
    }
  }
  if (rows.length === 0) return null;

  return (
    <div style={{ marginTop: 16 }}>
      <div className="display" style={{ fontSize: 11, marginBottom: 6 }}>Battle reports</div>
      <div style={{ color: "var(--text-dim)", fontSize: 10, marginBottom: 6 }}>
        {"QONQR's daily battle reports, top 50 players per zone"}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
          <thead>
            <tr>
              <th className="eyebrow" style={{ ...btCell, textAlign: "left" }}>Date</th>
              <th className="eyebrow" style={{ ...btCell, textAlign: "left" }}>Zone</th>
              <th className="eyebrow tabular" style={{ ...btCell, textAlign: "right" }}>Rank</th>
              <th className="eyebrow tabular" style={{ ...btCell, textAlign: "right" }}>Launches</th>
              <th className="eyebrow tabular" style={{ ...btCell, textAlign: "right" }}>Killed</th>
              <th className="eyebrow tabular" style={{ ...btCell, textAlign: "right" }}>Lost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.day}:${r.zone}`}>
                <td style={btCell}>{btDateFmt.format(new Date(r.day + "T00:00:00Z"))}</td>
                <td style={btCell}>{r.zone}</td>
                <td className="tabular" style={{ ...btCell, textAlign: "right" }}>{r.rank}</td>
                <td className="tabular" style={{ ...btCell, textAlign: "right" }}>{r.launches.toLocaleString("en-US")}</td>
                <td className="tabular" style={{ ...btCell, textAlign: "right" }}>{r.killed.toLocaleString("en-US")}</td>
                <td className="tabular" style={{ ...btCell, textAlign: "right" }}>{r.lost.toLocaleString("en-US")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
