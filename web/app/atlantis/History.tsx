"use client";

import { useMemo, useState, type CSSProperties } from "react";
import PlacementStrips from "./PlacementStrips";
import {
  factionColor,
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

function PlacementCell(props: { placement?: [string, number, number] }) {
  if (!props.placement) return <>{"—"}</>;
  return <span style={{ color: factionColor(props.placement[0]) }}>{props.placement[0]}</span>;
}

type TableSort = "month" | "players" | "stack" | "battle" | "length";

function sortVal(t: AnyTournament, col: TableSort): number | string {
  if (col === "month") return t.month;
  if (col === "players") return t.players;
  if (col === "stack") return t.stacking_days;
  if (col === "battle") return t.battle_days;
  return t.stacking_days + t.battle_days;
}

function isDerivedRow(t: AnyTournament): boolean {
  return isDerived(t) || ("is_derived_placements" in t && !!t.is_derived_placements);
}

function MonthRow(props: { t: AnyTournament; onClick: () => void }) {
  const t = props.t;
  return (
    <tr onClick={props.onClick} style={{ cursor: "pointer" }}>
      <td style={{ ...cellStyle, fontWeight: 600 }}>
        {t.month}
        {isDerivedRow(t) ? <span style={{ color: "var(--text-dim)", fontWeight: 400, marginLeft: 6, fontSize: 10 }}>derived</span> : null}
      </td>
      <td style={cellStyle}>
        {t.winner
          ? <span style={{ color: factionColor(t.winner) }}>{t.winner}</span>
          : <span style={{ color: "var(--text-dim)" }}>In progress</span>}
      </td>
      <td style={cellStyle}><PlacementCell placement={t.placements[0]} /></td>
      <td style={cellStyle}><PlacementCell placement={t.placements[1]} /></td>
      <td style={cellStyle}><PlacementCell placement={t.placements[2]} /></td>
      <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{t.players.toLocaleString("en-US")}</td>
      <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{t.stacking_days}</td>
      <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{t.battle_days}</td>
      <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{t.stacking_days + t.battle_days}</td>
    </tr>
  );
}

const ARROW_SLOT: CSSProperties = { display: "inline-block", width: 12, textAlign: "center" };

function MonthTable(props: { tournaments: AnyTournament[]; onMonthClick: (m: string) => void }) {
  const [sortCol, setSortCol] = useState<TableSort>("month");
  const [sortAsc, setSortAsc] = useState(false);

  const toggle = (col: TableSort) => {
    if (col === sortCol) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(col === "month"); }
  };
  const arrow = (col: TableSort) => <span style={ARROW_SLOT}>{col === sortCol ? (sortAsc ? "▲" : "▼") : ""}</span>;

  const sorted = useMemo(() => {
    const dir = sortAsc ? 1 : -1;
    return [...props.tournaments].sort((a, b) => {
      const av = sortVal(a, sortCol);
      const bv = sortVal(b, sortCol);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [props.tournaments, sortCol, sortAsc]);

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
            <MonthRow key={t.month} t={t} onClick={() => props.onMonthClick(t.month)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function History(props: Props) {
  const tournaments = useMemo(
    () => [...mergedTournaments(props.index)].reverse(),
    [props.index],
  );

  return (
    <div style={section}>
      <div className="display" style={{ fontSize: 13, marginBottom: 4 }}>Tournament history</div>
      <div style={{ color: "var(--text-dim)", fontSize: 11, marginBottom: 16 }}>
        {tournaments.length} months. Board months are exact; derived months estimated from battle reports.
      </div>
      <PlacementStrips tournaments={tournaments} />
      <MonthTable tournaments={tournaments} onMonthClick={props.onMonthClick} />
    </div>
  );
}
