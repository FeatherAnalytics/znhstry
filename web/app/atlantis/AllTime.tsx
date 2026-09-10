"use client";

import { useMemo, useState, useEffect, type CSSProperties } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { BASE } from "@/lib/dataOrigin";
import { MAZ_AMBER } from "@/components/charts/palette";
import {
  factionColor,
  factionHex,
  compact,
  formatDate,
  fetchPlayersDetail,
  type AtlantisIndex,
  type AllTimePlayer,
  type FactionDetail,
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

function FactionsCell({ factions, unattributed }: { factions: Record<string, FactionDetail>; unattributed: number }) {
  const entries = Object.entries(factions).sort(([, a], [, b]) => b.launches - a.launches);
  if (entries.length === 0) {
    return <span style={{ color: "var(--text-dim)", fontStyle: "italic", fontSize: 11 }}>not yet attributed</span>;
  }
  const parts = entries.map(([f, d]) => `${f}: ${d.launches.toLocaleString()}`);
  if (unattributed > 0) parts.push(`+ ${unattributed.toLocaleString()} unattributed`);
  return (
    <span style={{ display: "inline-flex", gap: 3 }} title={parts.join(", ")}>
      {entries.map(([f]) => (
        <span key={f} style={{ width: 8, height: 8, borderRadius: 2, background: factionColor(f) }} />
      ))}
    </span>
  );
}

type DetailSort = "launches" | "kills" | "lost" | "rank" | "qredits";
const DETAIL_COL_INDEX: Record<DetailSort, number> = { launches: 2, kills: 3, lost: 4, rank: 5, qredits: 6 };

function PlayerDetail({ name, onClose }: { name: string; onClose: () => void }) {
  const [data, setData] = useState<PlayerMonthRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [factionFilter, setFactionFilter] = useState<string | null>(null);
  const [detailSort, setDetailSort] = useState<DetailSort | null>(null);
  const [detailAsc, setDetailAsc] = useState(false);

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

  const factions = [...new Set(data.map(r => r[1]))];
  const filtered = factionFilter ? data.filter(r => r[1] === factionFilter) : data;
  const sorted = detailSort ? [...filtered].sort((a, b) => {
    const ci = DETAIL_COL_INDEX[detailSort];
    const av = a[ci] as number | null;
    const bv = b[ci] as number | null;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return detailAsc ? av - bv : bv - av;
  }) : filtered;

  const toggleDetailSort = (col: DetailSort) => {
    if (col === detailSort) setDetailAsc(!detailAsc);
    else { setDetailSort(col); setDetailAsc(false); }
  };
  const dArrow = (col: DetailSort) => col === detailSort ? (detailAsc ? " ▲" : " ▼") : "";
  const dthStyle: CSSProperties = { ...cellStyle, textAlign: "right" as const, cursor: "pointer", userSelect: "none" as const };

  return (
    <div style={{ borderTop: "2px solid var(--hairline-bright)", padding: "16px 16px 24px" }}>
      <PlayerDetailHeader
        name={name} factions={factions} factionFilter={factionFilter}
        onFilterChange={setFactionFilter} onClose={onClose}
      />
      <PlayerCharts rows={data} />
      <PlayerDetailTable rows={sorted} dthStyle={dthStyle} toggleDetailSort={toggleDetailSort} dArrow={dArrow} />
    </div>
  );
}

function Sparkline({ data, color, label }: { data: { month: string; value: number }[]; color: string; label: string }) {
  if (data.length === 0) return null;
  const maxV = Math.max(...data.map(d => d.value), 1);
  const w = 280;
  const h = 40;
  const barW = Math.max(2, Math.min(6, (w - 4) / data.length));
  const best = data.reduce((a, b) => b.value > a.value ? b : a);
  return (
    <div style={{ minWidth: 200 }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 2 }}>{label}</div>
      <svg width={w} height={h} style={{ display: "block" }}>
        {data.map((d, i) => (
          <rect key={d.month} x={i * barW} y={h - (d.value / maxV) * (h - 4)} width={barW - 1} height={(d.value / maxV) * (h - 4)}
            fill={color} opacity={0.7}>
            <title>{d.month}: {d.value.toLocaleString()}</title>
          </rect>
        ))}
      </svg>
      <div style={{ fontSize: 10, color: "var(--text-dim)" }}>Peak: {best.month} ({compact(best.value)})</div>
    </div>
  );
}

function YearBars({ data }: { data: { year: string; count: number }[] }) {
  if (data.length === 0) return null;
  const maxC = Math.max(...data.map(d => d.count), 1);
  return (
    <div style={{ minWidth: 200 }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 2 }}>Appearances per year</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 40 }}>
        {data.map(d => (
          <div key={d.year} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{ width: 16, height: (d.count / maxC) * 32, background: "var(--text-dim)", borderRadius: 1 }}
              title={`${d.year}: ${d.count}`} />
            <span className="tabular" style={{ fontSize: 8, color: "var(--text-dim)" }}>{d.year.slice(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlayerCharts({ rows }: { rows: PlayerMonthRow[] }) {
  const byMonth = useMemo(() => {
    const map: Record<string, { launches: number; kills: number }> = {};
    for (const r of rows) {
      const m = r[0];
      const prev = map[m] ?? { launches: 0, kills: 0 };
      map[m] = { launches: prev.launches + r[2], kills: prev.kills + r[3] };
    }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b)).map(([m, v]) => ({ month: m, ...v }));
  }, [rows]);

  const yearCounts = useMemo(() => {
    const yrs: Record<string, number> = {};
    for (const d of byMonth) {
      const y = d.month.slice(0, 4);
      yrs[y] = (yrs[y] ?? 0) + 1;
    }
    return Object.entries(yrs).sort(([a], [b]) => a.localeCompare(b)).map(([y, c]) => ({ year: y, count: c }));
  }, [byMonth]);

  if (byMonth.length === 0) return null;

  const showSparklines = byMonth.length >= 2;
  const launchData = byMonth.map(d => ({ month: d.month, value: d.launches }));
  const killData = byMonth.filter(d => d.kills > 0).map(d => ({ month: d.month, value: d.kills }));
  const bestLaunches = launchData.reduce((a, b) => b.value > a.value ? b : a);
  const bestKills = killData.length > 0 ? killData.reduce((a, b) => b.value > a.value ? b : a) : null;

  return (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 16 }}>
      {showSparklines ? (
        <>
          <Sparkline data={launchData} color="var(--text-dim)" label="Launches" />
          {killData.length >= 2 ? <Sparkline data={killData} color="var(--text-dim)" label="Kills" /> : null}
        </>
      ) : null}
      {!showSparklines ? (
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
          <div>Peak launches: {bestLaunches.month} ({compact(bestLaunches.value)})</div>
          {bestKills ? <div>Peak kills: {bestKills.month} ({compact(bestKills.value)})</div> : null}
        </div>
      ) : null}
      <YearBars data={yearCounts} />
    </div>
  );
}

function PlayerDetailHeader({ name, factions, factionFilter, onFilterChange, onClose }: {
  name: string; factions: string[]; factionFilter: string | null;
  onFilterChange: (f: string | null) => void; onClose: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
      <button type="button" onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 16 }}>×</button>
      <span className="display" style={{ fontSize: 16 }}>{name}</span>
      {factions.map(f => (
        <span key={f}
          onClick={() => onFilterChange(factionFilter === f ? null : f)}
          style={{ color: factionColor(f), fontSize: 12, cursor: "pointer", opacity: !factionFilter || factionFilter === f ? 1 : 0.4 }}
        >{f}</span>
      ))}
      {factions.length > 1 ? <span className="eyebrow" style={{ color: MAZ_AMBER, fontSize: 10 }}>mercenary</span> : null}
    </div>
  );
}

function PlayerDetailTable({ rows, dthStyle, toggleDetailSort, dArrow }: {
  rows: PlayerMonthRow[]; dthStyle: CSSProperties;
  toggleDetailSort: (col: DetailSort) => void; dArrow: (col: DetailSort) => string;
}) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
        <thead>
          <tr>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Month</th>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Faction</th>
            <th className="eyebrow tabular" style={dthStyle} onClick={() => toggleDetailSort("launches")}>Launches{dArrow("launches")}</th>
            <th className="eyebrow tabular" style={dthStyle} onClick={() => toggleDetailSort("kills")}>Kills{dArrow("kills")}</th>
            <th className="eyebrow tabular" style={dthStyle} onClick={() => toggleDetailSort("lost")}>Lost{dArrow("lost")}</th>
            <th className="eyebrow tabular" style={dthStyle} onClick={() => toggleDetailSort("rank")}>Rank{dArrow("rank")}</th>
            <th className="eyebrow tabular" style={dthStyle} onClick={() => toggleDetailSort("qredits")}>Qredits{dArrow("qredits")}</th>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([month, faction, launches, kills, lost, rank, qredits, source]) => (
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
              <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{qredits != null && qredits > 0 ? compact(qredits) : "—"}</td>
              <td style={{ ...cellStyle, color: "var(--text-dim)" }}>{source}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
      const diff = ((a[sortCol] ?? 0) - (b[sortCol] ?? 0)) * dir;
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
    let rank = 0;
    let prev = -Infinity;
    return sorted.map((r, i) => {
      const val = r[sortCol] ?? 0;
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

function TotalRow({ r, onClick }: { r: AllTimePlayer & { rank: number }; onClick: () => void }) {
  const multi = Object.keys(r.factions).length >= 2;
  const title = !multi && r.unattributed > 0 ? `+ ${r.unattributed.toLocaleString()} unattributed` : undefined;
  return (
    <tr>
      <td className="tabular" style={{ ...cellStyle, textAlign: "right", color: "var(--text-dim)" }}>{r.rank}</td>
      <td style={{ ...cellStyle, cursor: "pointer", fontWeight: multi ? 600 : 400 }} onClick={onClick}>{r.name}</td>
      <td style={cellStyle} title={title}><FactionsCell factions={r.factions} unattributed={r.unattributed ?? 0} /></td>
      <td className="tabular" style={{ ...cellStyle, textAlign: "right", fontWeight: multi ? 600 : 400 }}>{r.launches.toLocaleString()}</td>
      <td className="tabular" style={{ ...cellStyle, textAlign: "right", fontWeight: multi ? 600 : 400 }}>{r.tournaments}</td>
      <td className="tabular" style={{ ...cellStyle, color: "var(--text-dim)" }}>{r.first_month}</td>
      <td className="tabular" style={{ ...cellStyle, color: "var(--text-dim)" }}>{r.last_month}</td>
      <td className="tabular" style={{ ...cellStyle, textAlign: "right", fontWeight: multi ? 600 : 400 }}>
        {r.qredits != null && r.qredits > 0 ? compact(r.qredits) : "—"}
      </td>
    </tr>
  );
}

function FactionRow({ name, faction, detail, onClick }: { name: string; faction: string; detail: FactionDetail; onClick: () => void }) {
  return (
    <tr>
      <td style={cellStyle} />
      <td style={{ ...cellStyle, cursor: "pointer", paddingLeft: 24, color: "var(--text-dim)" }} onClick={onClick}>{name}</td>
      <td style={cellStyle}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: factionColor(faction) }} />
          <span style={{ fontSize: 11 }}>{faction}</span>
        </span>
      </td>
      <td className="tabular" style={{ ...cellStyle, textAlign: "right", color: "var(--text-dim)" }}>{detail.launches.toLocaleString()}</td>
      <td className="tabular" style={{ ...cellStyle, textAlign: "right", color: "var(--text-dim)" }}>{detail.tournaments}</td>
      <td style={cellStyle} />
      <td style={cellStyle} />
      <td className="tabular" style={{ ...cellStyle, textAlign: "right", color: "var(--text-dim)" }}>
        {detail.qredits > 0 ? compact(detail.qredits) : "—"}
      </td>
    </tr>
  );
}

function renderPlayerRows(r: AllTimePlayer & { rank: number }, onPlayerClick: (name: string) => void): React.ReactNode[] {
  const factionEntries = Object.entries(r.factions);
  const multi = factionEntries.length >= 2;
  const click = () => onPlayerClick(r.name);
  const rows: React.ReactNode[] = [<TotalRow key={r.name} r={r} onClick={click} />];
  if (multi) {
    for (const [f, d] of factionEntries) {
      rows.push(<FactionRow key={`${r.name}:${f}`} name={r.name} faction={f} detail={d} onClick={click} />);
    }
    if (r.unattributed > 0) {
      rows.push(
        <tr key={`${r.name}:unconfirmed`}>
          <td style={cellStyle} />
          <td style={{ ...cellStyle, paddingLeft: 24, color: "var(--text-dim)", fontStyle: "italic", fontSize: 11 }} colSpan={2}>Unconfirmed</td>
          <td className="tabular" style={{ ...cellStyle, textAlign: "right", color: "var(--text-dim)" }}>{r.unattributed.toLocaleString()}</td>
          <td style={cellStyle} /><td style={cellStyle} /><td style={cellStyle} /><td style={cellStyle} />
        </tr>,
      );
    }
  }
  return rows;
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
        <span style={{ position: "relative", display: "inline-block" }}>
          <input
            type="text"
            value={filter}
            onChange={e => onFilterChange(e.target.value)}
            placeholder="Filter by name..."
            style={{
              background: "var(--ink-raised)",
              border: "1px solid var(--hairline-bright)",
              borderRadius: 3,
              padding: "4px 24px 4px 8px",
              color: "var(--text)",
              fontSize: 12,
              width: 180,
            }}
          />
          {filter ? (
            <button type="button" onClick={() => onFilterChange("")}
              style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 12, padding: 0 }}
            >×</button>
          ) : null}
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
          <thead>
            <tr>
              <th className="eyebrow tabular" style={{ ...thStyle, textAlign: "right", cursor: "default", width: 40 }}>#</th>
              <th className="eyebrow" style={{ ...thStyle, textAlign: "left", cursor: "default" }}>Player</th>
              <th className="eyebrow" style={{ ...thStyle, textAlign: "left", cursor: "default" }}>Factions</th>
              <th className="eyebrow tabular" style={{ ...thStyle, textAlign: "right" }} onClick={() => toggleSort("launches")}>Launches{arrow("launches")}</th>
              <th className="eyebrow tabular" style={{ ...thStyle, textAlign: "right" }} onClick={() => toggleSort("tournaments")}>Tournaments{arrow("tournaments")}</th>
              <th className="eyebrow" style={{ ...thStyle, cursor: "default" }}>First</th>
              <th className="eyebrow" style={{ ...thStyle, cursor: "default" }}>Last</th>
              <th className="eyebrow tabular" style={{ ...thStyle, textAlign: "right" }} onClick={() => toggleSort("qredits")}>Qredits{arrow("qredits")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.flatMap(r => renderPlayerRows(r, onPlayerClick))}
          </tbody>
        </table>
        <div style={{ color: "var(--text-dim)", fontSize: 10, marginTop: 4 }}>
          Board months are exact; derived months estimated from battle reports. Months not yet attributed contribute nothing.
        </div>
      </div>
    </>
  );
}
