"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { factionColor, compact, type AtlantisIndex, type AllTimePlayer, type FactionAllTime } from "./lib";

interface Props {
  index: AtlantisIndex;
}

interface MergedPlayer {
  name: string;
  faction: string;
  launches: number;
  appearances: number;
  qredits: number;
  hasEstimate: boolean;
}

interface MergedFaction {
  faction: string;
  wins: number;
  qredits: number;
  hasEstimate: boolean;
}

type SortCol = "launches" | "appearances" | "qredits";

const cellStyle: CSSProperties = {
  padding: "12px 10px",
  borderBottom: "1px solid var(--hairline)",
  whiteSpace: "nowrap",
};

const thStyle: CSSProperties = {
  ...cellStyle,
  position: "sticky" as const,
  top: 0,
  background: "var(--ink)",
  cursor: "pointer",
  userSelect: "none",
};

const section: CSSProperties = { padding: "16px 16px 24px" };

function mergePlayers(exact: AllTimePlayer[], derived?: AllTimePlayer[]): MergedPlayer[] {
  const map = new Map<string, MergedPlayer>();
  for (const [name, faction, launches, apps, qredits] of exact) {
    const key = `${faction}:${name}`;
    map.set(key, { name, faction, launches, appearances: apps, qredits, hasEstimate: false });
  }
  for (const [name, faction, launches, apps, qredits] of derived ?? []) {
    const key = `${faction}:${name}`;
    const existing = map.get(key);
    if (existing) {
      existing.launches += launches;
      existing.appearances += apps;
      existing.qredits += qredits;
      existing.hasEstimate = true;
    } else {
      map.set(key, { name, faction, launches, appearances: apps, qredits, hasEstimate: true });
    }
  }
  return [...map.values()];
}

function mergeFactions(
  exact: Record<string, FactionAllTime>,
  derived?: Record<string, FactionAllTime>,
): MergedFaction[] {
  const map = new Map<string, MergedFaction>();
  for (const [f, d] of Object.entries(exact)) {
    map.set(f, { faction: f, wins: d.wins, qredits: d.qredits, hasEstimate: false });
  }
  for (const [f, d] of Object.entries(derived ?? {})) {
    const existing = map.get(f);
    if (existing) {
      existing.wins += d.wins;
      existing.qredits += d.qredits;
      existing.hasEstimate = true;
    } else {
      map.set(f, { faction: f, wins: d.wins, qredits: d.qredits, hasEstimate: true });
    }
  }
  return [...map.values()].sort((a, b) => b.wins - a.wins || b.qredits - a.qredits);
}

const NOTE = "Board months are exact; derived months estimated from battle reports. Months not yet attributed contribute nothing.";

function FactionTable({ factions, hasEstimate }: { factions: MergedFaction[]; hasEstimate: boolean }) {
  return (
    <>
      <div className="display" style={{ fontSize: 12, marginBottom: 8 }}>Factions</div>
      <div style={{ overflowX: "auto", marginBottom: 24 }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
          <thead>
            <tr>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Faction</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Wins</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>
                Qredits{hasEstimate ? " (exact + est.)" : ""}
              </th>
            </tr>
          </thead>
          <tbody>
            {factions.map(({ faction, wins, qredits, hasEstimate: est }) => (
              <tr key={faction}>
                <td style={{ ...cellStyle, color: factionColor(faction), fontWeight: 600 }}>{faction}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{wins}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>
                  {compact(qredits)}
                  {est ? <span style={{ color: "var(--text-dim)", marginLeft: 4, fontSize: 10 }}>derived</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {hasEstimate ? <div style={{ color: "var(--text-dim)", fontSize: 10, marginTop: 4 }}>{NOTE}</div> : null}
      </div>
    </>
  );
}

function PlayerTable({
  players, filter, onFilterChange, hasEstimate, sortCol, sortAsc, onSort, arrow, onPlayerClick,
}: {
  players: (MergedPlayer & { rank: number })[]; filter: string; onFilterChange: (v: string) => void;
  hasEstimate: boolean; sortCol: SortCol; sortAsc: boolean;
  onSort: (col: SortCol) => void; arrow: (col: SortCol) => string;
  onPlayerClick: (name: string) => void;
}) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <div className="display" style={{ fontSize: 12 }}>Players</div>
        <input
          type="text"
          value={filter}
          onChange={e => onFilterChange(e.target.value)}
          placeholder="Filter by name..."
          style={{
            background: "var(--ink-raised)",
            border: "1px solid var(--hairline-bright)",
            borderRadius: 3,
            padding: "4px 8px",
            color: "var(--text)",
            fontSize: 12,
            width: 180,
          }}
        />
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
          <thead>
            <tr>
              <th className="eyebrow tabular" style={{ ...thStyle, textAlign: "right", cursor: "default" }}>#</th>
              <th className="eyebrow" style={{ ...thStyle, textAlign: "left", cursor: "default" }}>Player</th>
              <th className="eyebrow" style={{ ...thStyle, textAlign: "left", cursor: "default" }}>Faction</th>
              <th className="eyebrow tabular" style={{ ...thStyle, textAlign: "right" }} onClick={() => onSort("launches")}>
                Launches{arrow("launches")}
              </th>
              <th className="eyebrow tabular" style={{ ...thStyle, textAlign: "right" }} onClick={() => onSort("appearances")}>
                Tournaments{arrow("appearances")}
              </th>
              <th className="eyebrow tabular" style={{ ...thStyle, textAlign: "right" }} onClick={() => onSort("qredits")}>
                Qredits{hasEstimate ? " (exact + est.)" : ""}{arrow("qredits")}
              </th>
            </tr>
          </thead>
          <tbody>
            {players.map(r => (
              <tr key={`${r.faction}:${r.name}`}>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right", color: "var(--text-dim)" }}>{r.rank}</td>
                <td style={{ ...cellStyle, cursor: "pointer", color: "var(--text)" }} onClick={() => onPlayerClick(r.name)}>{r.name}</td>
                <td style={cellStyle}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: factionColor(r.faction) }} />
                    {r.faction}
                  </span>
                </td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{r.launches.toLocaleString()}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{r.appearances}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>
                  {r.qredits > 0 ? compact(r.qredits) : r.launches > 0 ? (
                    <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>not yet attributed</span>
                  ) : "0"}
                  {r.hasEstimate && r.qredits > 0 ? (
                    <span style={{ color: "var(--text-dim)", marginLeft: 4, fontSize: 10 }}>derived</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {hasEstimate ? <div style={{ color: "var(--text-dim)", fontSize: 10, marginTop: 4 }}>{NOTE}</div> : null}
      </div>
    </>
  );
}


export default function AllTime({ index }: Props) {
  const searchParams = useSearchParams();
  const router = useRouter();

  const playerParam = searchParams.get("player");

  const factions = useMemo(
    () => mergeFactions(index.all_time.factions, index.all_time.factions_derived),
    [index],
  );

  const players = useMemo(
    () => mergePlayers(index.all_time.players, index.all_time.players_derived),
    [index],
  );

  const [sortCol, setSortCol] = useState<SortCol>("launches");
  const [sortAsc, setSortAsc] = useState(false);
  const [filter, setFilter] = useState(playerParam ?? "");

  const toggleSort = (col: SortCol) => {
    if (col === sortCol) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(false); }
  };
  const arrow = (col: SortCol) => (col === sortCol ? (sortAsc ? " ▲" : " ▼") : "");

  const ranked = useMemo(() => {
    const dir = sortAsc ? 1 : -1;
    const sorted = [...players].sort((a, b) => {
      const diff = (a[sortCol] - b[sortCol]) * dir;
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
    let rank = 0;
    let prev = -Infinity;
    return sorted.map((r, i) => {
      const val = r[sortCol];
      if (val !== prev) { rank = i + 1; prev = val; }
      return { ...r, rank };
    });
  }, [players, sortCol, sortAsc]);

  const filtered = useMemo(() => {
    if (!filter) return ranked;
    const q = filter.toLowerCase();
    return ranked.filter(r => r.name.toLowerCase().includes(q));
  }, [ranked, filter]);

  const onPlayerClick = (name: string) => {
    const p = new URLSearchParams(searchParams.toString());
    p.set("player", name);
    router.replace(`/atlantis/?${p.toString()}`, { scroll: false });
    setFilter(name);
  };

  const hasAnyDerived = players.some(p => p.hasEstimate);

  return (
    <div style={section}>
      <div className="display" style={{ fontSize: 13, marginBottom: 12 }}>All time standings</div>

      <FactionTable factions={factions} hasEstimate={hasAnyDerived} />

      <PlayerTable
        players={filtered}
        filter={filter}
        onFilterChange={setFilter}
        hasEstimate={hasAnyDerived}
        sortCol={sortCol}
        sortAsc={sortAsc}
        onSort={toggleSort}
        arrow={arrow}
        onPlayerClick={onPlayerClick}
      />
    </div>
  );
}
