"use client";

import { useMemo, useState, type CSSProperties } from "react";
import {
  deriveIntervals,
  factionColor,
  compact,
  FACTION_ORDER,
  type MonthPayload,
} from "./lib";

interface Props {
  month: MonthPayload;
  obsTimestamps: number[];
  onPlayerClick: (faction: string, name: string) => void;
}

interface Row {
  faction: string;
  name: string;
  launches: number;
  bestHr: number | null;
  tm: boolean;
  wm: boolean;
  qredits: number;
}

type SortCol = "launches" | "bestHr" | "qredits";

const cellStyle: CSSProperties = {
  padding: "12px 10px",
  borderBottom: "1px solid var(--hairline)",
  whiteSpace: "nowrap",
};

const thStyle: CSSProperties = {
  ...cellStyle,
  position: "sticky" as const,
  top: 0,
  background: "var(--ink-raised)",
  cursor: "pointer",
};

function lastNonNull(arr: (number | null)[]): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null) return i;
  }
  return -1;
}

function lastBool(arr: (boolean | null)[], idx: number): boolean {
  return idx >= 0 ? (arr[idx] ?? false) : false;
}

function playerToRow(faction: string, name: string, data: MonthPayload["players"][""][""], obsTs: number[]): Row {
  const lastIdx = lastNonNull(data.launches);
  const launches = lastIdx >= 0 ? (data.launches[lastIdx] ?? 0) : 0;
  const intervals = deriveIntervals(data.launches, obsTs);
  return {
    faction,
    name,
    launches,
    bestHr: intervals.length > 0 ? intervals.reduce((m, iv) => Math.max(m, iv.perHour), 0) : null,
    tm: lastBool(data.tm, lastIdx),
    wm: lastBool(data.wm, lastIdx),
    qredits: data.qredits ?? 0,
  };
}

function buildRows(month: MonthPayload, obsTs: number[]): Row[] {
  const rows: Row[] = [];
  for (const faction of FACTION_ORDER) {
    const players = month.players[faction];
    if (!players) continue;
    for (const [name, data] of Object.entries(players)) {
      rows.push(playerToRow(faction, name, data, obsTs));
    }
  }
  return rows;
}

export default function Leaderboard({ month, obsTimestamps, onPlayerClick }: Props) {
  const [filter, setFilter] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<SortCol>("launches");
  const [sortAsc, setSortAsc] = useState(false);

  const rows = useMemo(() => buildRows(month, obsTimestamps), [month, obsTimestamps]);

  const sorted = useMemo(() => {
    const filtered = filter ? rows.filter((r) => r.faction === filter) : rows;
    return [...filtered].sort((a, b) => {
      const diff = ((a[sortCol] as number | null) ?? -1) - ((b[sortCol] as number | null) ?? -1);
      return sortAsc ? diff : -diff;
    });
  }, [rows, filter, sortCol, sortAsc]);

  const toggleSort = (col: SortCol) => {
    if (col === sortCol) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(false); }
  };

  const arrow = (col: SortCol) => (col === sortCol ? (sortAsc ? " ▲" : " ▼") : "");

  return (
    <div>
      <div className="display" style={{ fontSize: 13, marginBottom: 10 }}>Leaderboard</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => setFilter(null)}
          style={{ ...cellStyle, cursor: "pointer", background: !filter ? "var(--hairline)" : "transparent", border: "1px solid var(--hairline-bright)", borderRadius: 3, color: "var(--text)" }}
        >
          All
        </button>
        {FACTION_ORDER.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(filter === f ? null : f)}
            style={{ ...cellStyle, cursor: "pointer", background: filter === f ? "var(--hairline)" : "transparent", border: "1px solid var(--hairline-bright)", borderRadius: 3, color: factionColor(f) }}
          >
            {f}
          </button>
        ))}
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
          <thead>
            <tr>
              <th className="eyebrow" style={{ ...thStyle, textAlign: "left" }}>Player</th>
              <th className="eyebrow" style={{ ...thStyle, textAlign: "left" }}>Faction</th>
              <th className="eyebrow tabular" style={{ ...thStyle, textAlign: "right" }} onClick={() => toggleSort("launches")}>Launches{arrow("launches")}</th>
              <th className="eyebrow tabular" style={{ ...thStyle, textAlign: "right" }} onClick={() => toggleSort("bestHr")}>Best /hr{arrow("bestHr")}</th>
              <th className="eyebrow" style={{ ...thStyle, textAlign: "center" }} title="Tournament Million Kills: 1,000,000+ kills in the current tournament (atlantis-gold badge)">Tournament 1M</th>
              <th className="eyebrow" style={{ ...thStyle, textAlign: "center" }} title="Weekly Million Kills: 1,000,000+ kills this week outside the tournament, weeks start 00:00 UTC Sunday (gold-star badge)">Weekly 1M</th>
              <th className="eyebrow tabular" style={{ ...thStyle, textAlign: "right" }} onClick={() => toggleSort("qredits")}>Qredits{arrow("qredits")}{!month.is_finished ? " (est.)" : ""}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={`${r.faction}:${r.name}`}>
                <td style={{ ...cellStyle, cursor: "pointer", color: "var(--text)" }} onClick={() => onPlayerClick(r.faction, r.name)}>{r.name}</td>
                <td style={cellStyle}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: factionColor(r.faction) }} />
                    {r.faction}
                  </span>
                </td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{r.launches.toLocaleString()}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{r.bestHr != null ? Math.round(r.bestHr).toLocaleString() : "—"}</td>
                <td style={{ ...cellStyle, textAlign: "center" }}>{r.tm ? "★" : ""}</td>
                <td style={{ ...cellStyle, textAlign: "center" }}>{r.wm ? "★" : ""}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{compact(r.qredits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
