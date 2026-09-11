"use client";

import { useMemo, type CSSProperties } from "react";
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
const HEIGHT = 180;
const BAR_HEIGHT = 100;

const section: CSSProperties = {
  padding: "16px 16px 24px",
  borderTop: "1px solid var(--hairline)",
  background: "var(--ink-raised)",
};

function topIntervals(intervals: Interval[], count: number): Interval[] {
  return [...intervals].sort((a, b) => b.perHour - a.perHour).slice(0, count);
}

function LaunchesCurve({ data, obsTs, color }: { data: (number | null)[]; obsTs: number[]; color: string }) {
  const n = obsTs.length;
  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const { path, top, xMin, xSpan } = useMemo(() => {
    let top = 1;
    for (const v of data) if (v !== null && v > top) top = v;
    const xMin = n > 0 ? obsTs[0] : 0;
    const xSpan = Math.max(1, (n > 0 ? obsTs[n - 1] : 1) - xMin);

    const px = (i: number) => PAD.left + ((obsTs[i] - xMin) / xSpan) * plotW;
    const py = (v: number) => PAD.top + plotH - (v / top) * plotH;

    let path = "";
    let drawing = false;
    for (let i = 0; i < n; i++) {
      const v = data[i];
      if (v === null) { drawing = false; continue; }
      path += `${drawing ? "L" : "M"}${px(i).toFixed(1)} ${py(v).toFixed(1)}`;
      drawing = true;
    }
    return { path, top, xMin, xSpan };
  }, [data, obsTs, n, plotW, plotH]);

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Launches">
      {[0, 0.5, 1].map((f) => {
        const y = PAD.top + plotH - f * plotH;
        return (
          <g key={f}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y} stroke="var(--hairline)" strokeWidth={1} />
            <text x={PAD.left - 8} y={y + 3} textAnchor="end" fontSize={9} fill="var(--text-dim)" className="tabular">{compact(top * f)}</text>
          </g>
        );
      })}
      <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      {n > 0 ? (
        <>
          <text x={PAD.left} y={HEIGHT - 8} fontSize={9} fill="var(--text-dim)" className="tabular">{formatObs(obsTs[0])}</text>
          <text x={WIDTH - PAD.right} y={HEIGHT - 8} fontSize={9} fill="var(--text-dim)" textAnchor="end" className="tabular">{formatObs(obsTs[n - 1])}</text>
        </>
      ) : null}
    </svg>
  );
}

function GainsBars({ intervals, obsTs, color }: { intervals: Interval[]; obsTs: number[]; color: string }) {
  const n = obsTs.length;
  if (!n || intervals.length === 0) return null;

  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = BAR_HEIGHT - PAD.top - 10;
  const xMin = obsTs[0];
  const xSpan = Math.max(1, obsTs[n - 1] - xMin);
  const maxGain = Math.max(1, ...intervals.map((iv) => iv.gained));
  const top3 = topIntervals(intervals, 3);

  const px = (i: number) => PAD.left + ((obsTs[i] - xMin) / xSpan) * plotW;

  return (
    <svg viewBox={`0 0 ${WIDTH} ${BAR_HEIGHT}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Gains per interval">
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
              opacity={isTop ? 0.9 : 0.4}
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
  );
}

export default function PlayerDetail({ faction, playerName, month, obsTimestamps, onClose }: Props) {
  const data = month.players[faction]?.[playerName];
  if (!data) return null;

  const intervals = useMemo(
    () => deriveIntervals(data.launches, obsTimestamps),
    [data.launches, obsTimestamps],
  );

  const factionTotal = Object.values(month.players[faction] ?? {}).reduce(
    (sum, p) => sum + (p.qredits ?? 0), 0,
  );
  const share = factionTotal > 0 ? ((data.qredits ?? 0) / factionTotal * 100).toFixed(1) : "0";
  const color = factionHex(faction);

  return (
    <div style={section}>
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
      <LaunchesCurve data={data.launches} obsTs={obsTimestamps} color={color} />

      <div className="display" style={{ fontSize: 11, marginBottom: 4, marginTop: 12 }} title="Launches gained between the first and last observation we hold — see the coverage line for this month's window">Gains per interval (in coverage)</div>
      <GainsBars intervals={intervals} obsTs={obsTimestamps} color={color} />
      <span className="compact-footnote eyebrow" style={{ color: "var(--text-dim)", marginTop: 4, fontSize: 9 }}>
        Gains cover observed hours only
      </span>

      <BadgeMarkers data={data} obsTimestamps={obsTimestamps} />

      <BattleReports playerName={playerName} month={month} />

      <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 12 }}>
        Hourly observations; a rate is launches gained between observations.
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
