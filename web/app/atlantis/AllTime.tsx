"use client";

import { useMemo, useState, useEffect, type CSSProperties } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { BASE } from "@/lib/dataOrigin";
import {
  factionColor,
  factionHex,
  compact,
  formatDate,
  fetchPlayersDetail,
  type AtlantisIndex,
  type AllTimePlayer,
  type FactionAllTime,
  type PlayerMonthRow,
} from "./lib";

interface Props {
  index: AtlantisIndex;
}

type SortCol = "launches" | "tournaments" | "qredits";

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

const SHORTFALL_NOTE =
  "Faction launches from 2019-07 to 2019-09-11 are understated " +
  "(the report header's per-faction split was partial on 861 reports in that window).";

function FactionTable({ factions }: { factions: Record<string, FactionAllTime> }) {
  const list = Object.entries(factions).sort(
    ([, a], [, b]) => b.wins - a.wins || b.qredits - a.qredits,
  );
  return (
    <>
      <div className="display" style={{ fontSize: 12, marginBottom: 8 }}>Factions</div>
      <div style={{ overflowX: "auto", marginBottom: 8 }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
          <thead>
            <tr>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Faction</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Wins</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Launches</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Qredits (exact + est.)</th>
            </tr>
          </thead>
          <tbody>
            {list.map(([faction, data]) => (
              <tr key={faction}>
                <td style={{ ...cellStyle, color: factionColor(faction), fontWeight: 600 }}>{faction}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{data.wins}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{compact(data.launches ?? 0)}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{compact(data.qredits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ color: "var(--text-dim)", fontSize: 10, marginBottom: 24 }}>{SHORTFALL_NOTE}</div>
    </>
  );
}

function FactionsCell({ factions, unattributed }: { factions: Record<string, number>; unattributed: number }) {
  const entries = Object.entries(factions).sort(([, a], [, b]) => b - a);
  if (entries.length === 0) {
    return <span style={{ color: "var(--text-dim)", fontStyle: "italic", fontSize: 11 }}>not yet attributed</span>;
  }
  const parts = entries.map(([f, l]) => `${f}: ${l.toLocaleString()}`);
  if (unattributed > 0) parts.push(`+ ${unattributed.toLocaleString()} unattributed`);
  return (
    <span style={{ display: "inline-flex", gap: 3 }} title={parts.join(", ")}>
      {entries.map(([f]) => (
        <span key={f} style={{ width: 8, height: 8, borderRadius: 2, background: factionColor(f) }} />
      ))}
    </span>
  );
}

function PlayerDetail({ name, onClose }: { name: string; onClose: () => void }) {
  const [data, setData] = useState<PlayerMonthRow[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    fetchPlayersDetail(BASE).then(
      (all) => { if (live) setData(all[name] ?? []); },
      () => { if (live) setData([]); },
    ).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [name]);

  if (loading) return <div style={{ padding: 16, color: "var(--text-dim)" }}>Loading player…</div>;
  if (!data || data.length === 0) return <div style={{ padding: 16, color: "var(--text-dim)" }}>No data for {name}.</div>;

  const factions = new Set(data.map(r => r[1]));

  return (
    <div style={{ borderTop: "2px solid var(--hairline-bright)", padding: "16px 16px 24px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
        <button type="button" onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 16 }}>×</button>
        <span className="display" style={{ fontSize: 16 }}>{name}</span>
        {[...factions].map(f => (
          <span key={f} style={{ color: factionColor(f), fontSize: 12 }}>{f}</span>
        ))}
        {factions.size > 1 ? <span style={{ color: "var(--text-dim)", fontSize: 10 }}>⚔ mercenary</span> : null}
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
          <thead>
            <tr>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Month</th>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Faction</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Launches</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Kills</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Lost</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Rank</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Qredits</th>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Source</th>
            </tr>
          </thead>
          <tbody>
            {data.map(([month, faction, launches, kills, lost, rank, qredits, source]) => (
              <tr key={`${month}:${faction}`}>
                <td className="tabular" style={cellStyle}>{month}</td>
                <td style={cellStyle}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: factionColor(faction) }} />
                    {faction}
                  </span>
                </td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{launches.toLocaleString()}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{kills.toLocaleString()}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{lost.toLocaleString()}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{rank ?? "—"}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{qredits > 0 ? compact(qredits) : "—"}</td>
                <td style={{ ...cellStyle, color: "var(--text-dim)" }}>{source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AllTime({ index }: Props) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const playerParam = searchParams.get("player");

  const players = index.all_time.players;
  const factions = index.all_time.factions;

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

  const onPlayerClose = () => {
    const p = new URLSearchParams(searchParams.toString());
    p.delete("player");
    router.replace(`/atlantis/?${p.toString()}`, { scroll: false });
    setFilter("");
  };

  return (
    <div style={section}>
      <div className="display" style={{ fontSize: 13, marginBottom: 12 }}>All time standings</div>

      <FactionTable factions={factions} />

      <PlayersTable
        filtered={filtered}
        filter={filter}
        onFilterChange={setFilter}
        sortCol={sortCol}
        sortAsc={sortAsc}
        toggleSort={toggleSort}
        arrow={arrow}
        onPlayerClick={onPlayerClick}
      />

      {playerParam ? (
        <PlayerDetail name={playerParam} onClose={onPlayerClose} />
      ) : null}
    </div>
  );
}

function PlayersTable({
  filtered, filter, onFilterChange, sortCol, sortAsc, toggleSort, arrow, onPlayerClick,
}: {
  filtered: (AllTimePlayer & { rank: number })[];
  filter: string;
  onFilterChange: (v: string) => void;
  sortCol: SortCol;
  sortAsc: boolean;
  toggleSort: (col: SortCol) => void;
  arrow: (col: SortCol) => string;
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
              <th className="eyebrow tabular" style={{ ...thStyle, textAlign: "right", cursor: "default", width: 40 }}>#</th>
              <th className="eyebrow" style={{ ...thStyle, textAlign: "left", cursor: "default" }}>Player</th>
              <th className="eyebrow" style={{ ...thStyle, textAlign: "left", cursor: "default" }}>Factions</th>
              <th className="eyebrow tabular" style={thStyle} onClick={() => toggleSort("launches")}>Launches{arrow("launches")}</th>
              <th className="eyebrow tabular" style={thStyle} onClick={() => toggleSort("tournaments")}>Tournaments{arrow("tournaments")}</th>
              <th className="eyebrow" style={{ ...thStyle, cursor: "default" }}>First</th>
              <th className="eyebrow" style={{ ...thStyle, cursor: "default" }}>Last</th>
              <th className="eyebrow tabular" style={thStyle} onClick={() => toggleSort("qredits")}>Qredits{arrow("qredits")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.name}>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right", color: "var(--text-dim)" }}>{r.rank}</td>
                <td style={{ ...cellStyle, cursor: "pointer", color: "var(--text)" }} onClick={() => onPlayerClick(r.name)}>{r.name}</td>
                <td style={cellStyle}><FactionsCell factions={r.factions} unattributed={r.unattributed ?? 0} /></td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{r.launches.toLocaleString()}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{r.tournaments}</td>
                <td className="tabular" style={{ ...cellStyle, color: "var(--text-dim)" }}>{r.first_month}</td>
                <td className="tabular" style={{ ...cellStyle, color: "var(--text-dim)" }}>{r.last_month}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>
                  {r.qredits > 0 ? compact(r.qredits) : r.launches > 0 ? (
                    <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>not yet attributed</span>
                  ) : "0"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ color: "var(--text-dim)", fontSize: 10, marginTop: 4 }}>
          Board months are exact; derived months estimated from battle reports. Months not yet attributed contribute nothing.
        </div>
      </div>
    </>
  );
}
