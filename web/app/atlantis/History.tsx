"use client";

import { useMemo, useState, type CSSProperties } from "react";
import {
  factionColor,
  factionHex,
  mergedTournaments,
  isDerived,
  type AtlantisIndex,
  type AnyTournament,
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

function stripTitle(t: AnyTournament): string {
  const zones = t.placements.map(p => `${p[0]}: ${p[1]} zones`).join("\n");
  const derived = isDerived(t) || ("is_derived_placements" in t && t.is_derived_placements);
  return `${t.month}${derived ? " (derived)" : ""}\n${zones}`;
}

function PlacementStrips({ tournaments }: { tournaments: AnyTournament[] }) {
  const sorted = [...tournaments].sort((a, b) => a.month.localeCompare(b.month));
  const labelW = 24;
  const labels = ["1st", "2nd", "3rd"] as const;

  return (
    <div style={{ marginBottom: 16 }}>
      {labels.map((label, place) => (
        <div key={label} style={{ display: "flex", alignItems: "center", marginBottom: place < 2 ? 4 : 0 }}>
          <span className="eyebrow" style={{ width: labelW, flexShrink: 0, fontSize: 10 }}>{label}</span>
          <div style={{ display: "flex", flex: 1, gap: 1, minWidth: 0, overflow: "hidden" }}>
            {sorted.map(t => {
              const faction = t.placements[place]?.[0] ?? null;
              const isYear = t.month.endsWith("-01");
              return (
                <div key={t.month} title={stripTitle(t)} style={{
                  flex: "1 1 0", height: 16, borderRadius: 1, minWidth: 0,
                  background: faction ? factionHex(faction) : "#333",
                  marginLeft: isYear ? 6 : 0,
                }} />
              );
            })}
          </div>
        </div>
      ))}
      <div style={{ display: "flex", paddingLeft: labelW, gap: 1, overflow: "hidden" }}>
        {sorted.map(t => {
          const isYear = t.month.endsWith("-01");
          return (
            <div key={t.month} style={{ flex: "1 1 0", marginLeft: isYear ? 6 : 0 }}>
              {isYear ? <span className="tabular" style={{ fontSize: 9, color: "var(--text-dim)" }}>{t.month.slice(0, 4)}</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlacementCell({ placement }: { placement?: [string, number, number] }) {
  if (!placement) return <>{"—"}</>;
  return <span style={{ color: factionColor(placement[0]) }}>{placement[0]}</span>;
}

type TableSort = "month" | "players" | "stack" | "battle" | "length";

function sortVal(t: AnyTournament, col: TableSort): number | string {
  if (col === "month") return t.month;
  if (col === "players") return t.players;
  if (col === "stack") return t.stacking_days;
  if (col === "battle") return t.battle_days;
  return t.stacking_days + t.battle_days;
}

function MonthRow({ t, onClick }: { t: AnyTournament; onClick: () => void }) {
  return (
    <tr onClick={onClick} style={{ cursor: "pointer" }}>
      <td style={{ ...cellStyle, fontWeight: 600 }}>
        {t.month}
        {isDerived(t) || ("is_derived_placements" in t && t.is_derived_placements) ? <span style={{ color: "var(--text-dim)", fontWeight: 400, marginLeft: 6, fontSize: 10 }}>derived</span> : null}
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
      <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{t.stacking_days}</td>
      <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{t.battle_days}</td>
      <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{t.stacking_days + t.battle_days}</td>
    </tr>
  );
}

const ARROW_SLOT: CSSProperties = { display: "inline-block", width: 12, textAlign: "center" };

function MonthTable({ tournaments, onMonthClick }: { tournaments: AnyTournament[]; onMonthClick: (m: string) => void }) {
  const [sortCol, setSortCol] = useState<TableSort>("month");
  const [sortAsc, setSortAsc] = useState(false);

  const toggle = (col: TableSort) => {
    if (col === sortCol) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(col === "month"); }
  };
  const arrow = (col: TableSort) => <span style={ARROW_SLOT}>{col === sortCol ? (sortAsc ? "▲" : "▼") : ""}</span>;

  const sorted = useMemo(() => {
    const dir = sortAsc ? 1 : -1;
    return [...tournaments].sort((a, b) => {
      const av = sortVal(a, sortCol);
      const bv = sortVal(b, sortCol);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [tournaments, sortCol, sortAsc]);

  const sth: CSSProperties = { ...cellStyle, textAlign: "right", cursor: "pointer", userSelect: "none" };

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
        <thead>
          <tr>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left", cursor: "pointer", userSelect: "none" }} onClick={() => toggle("month")}>Month{arrow("month")}</th>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Winner</th>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>1st</th>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>2nd</th>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>3rd</th>
            <th className="eyebrow tabular" style={sth} onClick={() => toggle("players")}>Players{arrow("players")}</th>
            <th className="eyebrow tabular" style={sth} onClick={() => toggle("stack")}>Stack{arrow("stack")}</th>
            <th className="eyebrow tabular" style={sth} onClick={() => toggle("battle")}>Battle{arrow("battle")}</th>
            <th className="eyebrow tabular" style={sth} onClick={() => toggle("length")}>Length{arrow("length")}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(t => (
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
      <div className="display" style={{ fontSize: 13, marginBottom: 4 }}>Tournament history</div>
      <div style={{ color: "var(--text-dim)", fontSize: 11, marginBottom: 16 }}>
        {tournaments.length} months. Board months are exact; derived months estimated from battle reports.
      </div>
      <PlacementStrips tournaments={tournaments} />
      <MonthTable tournaments={tournaments} onMonthClick={onMonthClick} />
    </div>
  );
}
