"use client";

import { useMemo, type CSSProperties } from "react";
import { FACTIONS } from "@/components/charts/palette";
import {
  factionColor,
  factionHex,
  formatDateTime,
  formatDate,
  mergedTournaments,
  isDerived,
  type AtlantisIndex,
  type AnyTournament,
  type DerivedTournamentSummary,
} from "./lib";

interface Props {
  index: AtlantisIndex;
  onMonthClick: (month: string) => void;
}

const cellStyle: CSSProperties = {
  padding: "12px 10px",
  borderBottom: "1px solid var(--hairline)",
  whiteSpace: "nowrap",
};

const section: CSSProperties = { padding: "16px 16px 24px" };

function coverageOf(t: AnyTournament): string {
  if (isDerived(t)) {
    return `${t.reports} reports, ${formatDate(t.first_report_date)} to ${formatDate(t.last_report_date)}`;
  }
  if (t.first_observed_at === t.last_observed_at) {
    return `1 observation, ${formatDateTime(t.first_observed_at)}`;
  }
  return `${formatDateTime(t.first_observed_at)} to ${formatDateTime(t.last_observed_at)}`;
}

function scheduleOf(t: AnyTournament): string {
  const base = `${t.stacking_days}d / ${t.battle_days}d`;
  if (isDerived(t)) {
    const d = t as DerivedTournamentSummary;
    const tol = d.end_tolerance_days === 1 ? " ±1 d" : "";
    const note = d.schedule_note ? ` · ${d.schedule_note}` : "";
    return base + tol + note;
  }
  return base;
}

const FACTION_NAMES = FACTIONS.map(f => f.label);

function PlacementStrips({ tournaments }: { tournaments: AnyTournament[] }) {
  const sorted = [...tournaments].sort((a, b) => a.month.localeCompare(b.month));
  const labelW = 24;
  const barW = Math.max(2, Math.min(6, 500 / sorted.length));
  const svgW = sorted.length * barW;
  const h = 16;
  const labels = ["1st", "2nd", "3rd"] as const;

  const yearTicks: { x: number; label: string }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].month.endsWith("-01")) {
      yearTicks.push({ x: i * barW + barW / 2, label: sorted[i].month.slice(0, 4) });
    }
  }

  return (
    <div style={{ marginBottom: 16 }}>
      {labels.map((label, place) => (
        <div key={label} style={{ display: "flex", alignItems: "center", marginBottom: place < 2 ? 2 : 0 }}>
          <span className="eyebrow" style={{ width: labelW, flexShrink: 0, fontSize: 10 }}>{label}</span>
          <svg viewBox={`0 0 ${svgW} ${h}`} style={{ width: "100%", height: h }} preserveAspectRatio="none">
            {sorted.map((t, i) => {
              const faction = t.placements[place]?.[0] ?? null;
              return (
                <rect key={t.month} x={i * barW} y={0} width={barW - 0.5} height={h}
                  fill={faction ? factionHex(faction) : "#333"}
                >
                  <title>{t.month} · {faction ?? "—"}</title>
                </rect>
              );
            })}
          </svg>
        </div>
      ))}
      <div style={{ display: "flex", paddingLeft: labelW }}>
        <svg viewBox={`0 0 ${svgW} 12`} style={{ width: "100%", height: 12 }} preserveAspectRatio="none">
          {yearTicks.map(({ x, label }) => (
            <text key={label + x} x={x} y={10} textAnchor="middle" fontSize={barW * 1.8} fill="var(--text-dim)">
              {label}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}

function PlacementCounts({ tournaments }: { tournaments: AnyTournament[] }) {
  const counts: Record<string, [number, number, number]> = {};
  for (const f of FACTION_NAMES) counts[f] = [0, 0, 0];
  for (const t of tournaments) {
    for (let i = 0; i < 3; i++) {
      const p = t.placements[i];
      if (p && counts[p[0]]) counts[p[0]][i]++;
    }
  }
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="eyebrow" style={{ marginBottom: 4 }}>Placements</div>
      <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Faction</th>
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>1st</th>
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>2nd</th>
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>3rd</th>
          </tr>
        </thead>
        <tbody>
          {FACTION_NAMES.map(f => (
            <tr key={f}>
              <td style={{ ...cellStyle, color: factionColor(f), fontWeight: 600 }}>{f}</td>
              <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{counts[f][0]}</td>
              <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{counts[f][1]}</td>
              <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{counts[f][2]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WinStreaks({ tournaments }: { tournaments: AnyTournament[] }) {
  const sorted = [...tournaments].sort((a, b) => a.month.localeCompare(b.month));
  const streaks: Record<string, { current: number; longest: number }> = {};
  for (const f of FACTION_NAMES) streaks[f] = { current: 0, longest: 0 };

  for (const f of FACTION_NAMES) {
    let run = 0;
    let best = 0;
    for (const t of sorted) {
      if (t.winner === f) { run++; best = Math.max(best, run); }
      else run = 0;
    }
    streaks[f] = { current: run, longest: best };
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div className="eyebrow" style={{ marginBottom: 4 }}>Win streaks</div>
      <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Faction</th>
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Current</th>
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Longest</th>
          </tr>
        </thead>
        <tbody>
          {FACTION_NAMES.map(f => (
            <tr key={f}>
              <td style={{ ...cellStyle, color: factionColor(f), fontWeight: 600 }}>{f}</td>
              <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{streaks[f].current}</td>
              <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{streaks[f].longest}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Histogram({ values, label, rangeMin }: { values: number[]; label: string; rangeMin: number }) {
  const counts: Record<number, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  const lo = Math.min(rangeMin, ...values);
  const hi = Math.max(...values);
  const max = Math.max(...Object.values(counts), 1);
  const keys: number[] = [];
  for (let k = lo; k <= hi; k++) keys.push(k);
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="eyebrow" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 40 }}>
        {keys.map(k => (
          <div key={k} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div
              style={{ width: 16, height: ((counts[k] ?? 0) / max) * 32, background: "var(--text-dim)", borderRadius: 1 }}
              title={`${k}: ${counts[k] ?? 0}`}
            />
            <span className="tabular" style={{ fontSize: 9, color: "var(--text-dim)" }}>{k}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ZoneExceptions({ tournaments }: { tournaments: AnyTournament[] }) {
  const exceptions = tournaments.filter(t => {
    if (isDerived(t)) return (t as DerivedTournamentSummary).zone_count !== 19;
    return false;
  });
  if (exceptions.length === 0) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="eyebrow" style={{ marginBottom: 4 }}>Zone count exceptions</div>
      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
        {exceptions.map(t => {
          const d = t as DerivedTournamentSummary;
          return <div key={t.month}>{t.month}: {d.zone_count} zones</div>;
        })}
      </div>
    </div>
  );
}

function HistoryDashboard({ tournaments }: { tournaments: AnyTournament[] }) {
  const stackingDays = tournaments.map(t => t.stacking_days);
  const battleDays = tournaments.map(t => t.battle_days);
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ color: "var(--text-dim)", fontSize: 11, marginBottom: 16 }}>
        {tournaments.length} months. Board months are exact; derived months estimated from battle reports.
      </div>
      <PlacementStrips tournaments={tournaments} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px 24px" }}>
        <PlacementCounts tournaments={tournaments} />
        <WinStreaks tournaments={tournaments} />
        <Histogram values={stackingDays} label="Stacking days" rangeMin={0} />
        <Histogram values={battleDays} label="Battle days" rangeMin={1} />
      </div>
      <ZoneExceptions tournaments={tournaments} />
    </div>
  );
}

function PlacementCell({ placement }: { placement?: [string, number, number] }) {
  if (!placement) return <>{"—"}</>;
  return <span style={{ color: factionColor(placement[0]) }}>{placement[0]}</span>;
}

function MonthRow({ t, onClick }: { t: AnyTournament; onClick: () => void }) {
  return (
    <tr onClick={onClick} style={{ cursor: "pointer" }}>
      <td style={{ ...cellStyle, fontWeight: 600 }}>
        {t.month}
        {isDerived(t) ? (
          <span style={{ color: "var(--text-dim)", fontWeight: 400, marginLeft: 6, fontSize: 10 }} title="derived from battle reports">
            derived
          </span>
        ) : null}
      </td>
      <td style={cellStyle}>
        {t.winner
          ? <span style={{ color: factionColor(t.winner) }}>{t.winner}</span>
          : <span style={{ color: "var(--text-dim)" }}>In progress</span>}
      </td>
      <td style={cellStyle}><PlacementCell placement={t.placements[0]} /></td>
      <td style={cellStyle}><PlacementCell placement={t.placements[1]} /></td>
      <td style={cellStyle}><PlacementCell placement={t.placements[2]} /></td>
      <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{t.players.toLocaleString()}</td>
      <td style={{ ...cellStyle, color: "var(--text-dim)", fontSize: 11 }}>{scheduleOf(t)}</td>
      <td style={{ ...cellStyle, color: "var(--text-dim)", fontSize: 11 }}>{coverageOf(t)}</td>
    </tr>
  );
}

const MONTH_HEADERS = ["Month", "Winner", "1st", "2nd", "3rd"] as const;

function MonthTable({ tournaments, onMonthClick }: { tournaments: AnyTournament[]; onMonthClick: (m: string) => void }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
        <thead>
          <tr>
            {MONTH_HEADERS.map(h => (
              <th key={h} className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>{h}</th>
            ))}
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Players</th>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Schedule</th>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Coverage</th>
          </tr>
        </thead>
        <tbody>
          {tournaments.map(t => (
            <MonthRow key={t.month} t={t} onClick={() => onMonthClick(t.month)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function History({ index, onMonthClick }: Props) {
  const tournaments = useMemo(
    () => [...mergedTournaments(index)].reverse(),
    [index],
  );

  return (
    <div style={section}>
      <div className="display" style={{ fontSize: 13, marginBottom: 12 }}>Tournament history</div>
      <HistoryDashboard tournaments={tournaments} />
      <MonthTable tournaments={tournaments} onMonthClick={onMonthClick} />
    </div>
  );
}
