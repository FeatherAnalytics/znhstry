"use client";

import { useMemo, useState, useEffect, type CSSProperties } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { BASE } from "@/lib/dataOrigin";
import { MAZ_AMBER } from "@/components/charts/palette";
import {
  factionColor,
  compact,
  fetchPlayersDetail,
  type AtlantisIndex,
  type AllTimePlayer,
  type FactionDetail,
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

const ARROW_SLOT: CSSProperties = { display: "inline-block", width: 12, textAlign: "center" };

const thStyle: CSSProperties = {
  ...cellStyle,
  position: "sticky" as const,
  top: 0,
  background: "var(--ink)",
  cursor: "pointer",
  userSelect: "none",
};

const section: CSSProperties = { padding: "16px 16px 24px" };

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

type DetailSort = "month" | "launches" | "kills" | "lost" | "rank" | "qredits";
const DETAIL_COL_INDEX: Record<Exclude<DetailSort, "month">, number> = { launches: 2, kills: 3, lost: 4, rank: 5, qredits: 6 };

function PlayerDetail({ name, onClose }: { name: string; onClose: () => void }) {
  const [data, setData] = useState<PlayerMonthRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [factionFilter, setFactionFilter] = useState<string | null>(null);
  const [detailSort, setDetailSort] = useState<DetailSort>("month");
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

  const factions = [...new Set(data.map(r => r[1]))].filter(f => f !== "Unconfirmed");
  const filtered = factionFilter ? data.filter(r => r[1] === factionFilter) : data;
  const sorted = sortDetailRows(filtered, detailSort, detailAsc);

  const toggleDetailSort = (col: DetailSort) => {
    if (col === detailSort) setDetailAsc(!detailAsc);
    else { setDetailSort(col); setDetailAsc(col === "month" ? false : false); }
  };
  const dArrow = (col: DetailSort) => <span style={ARROW_SLOT}>{col === detailSort ? (detailAsc ? "▲" : "▼") : ""}</span>;

  return (
    <div style={{ borderTop: "2px solid var(--hairline-bright)", padding: "16px 16px 24px" }}>
      <PlayerDetailHeader
        name={name} factions={factions} factionFilter={factionFilter}
        onFilterChange={f => setFactionFilter(factionFilter === f ? null : f)} onClose={onClose}
      />
      <PlayerInfoRow data={data} />
      <PlayerCharts rows={data} />
      <PlayerDetailTable rows={sorted} detailSort={detailSort} toggleDetailSort={toggleDetailSort} dArrow={dArrow} />
    </div>
  );
}

function sortDetailRows(rows: PlayerMonthRow[], col: DetailSort, asc: boolean): PlayerMonthRow[] {
  return [...rows].sort((a, b) => {
    if (col === "month") {
      return asc ? a[0].localeCompare(b[0]) : b[0].localeCompare(a[0]);
    }
    const ci = DETAIL_COL_INDEX[col];
    const av = a[ci] as number | null;
    const bv = b[ci] as number | null;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return asc ? av - bv : bv - av;
  });
}

function FactionBreakdown({ data }: { data: PlayerMonthRow[] }) {
  const totals: Record<string, { launches: number; kills: number; tournaments: number; qredits: number }> = {};
  const months: Record<string, Set<string>> = {};
  for (const r of data) {
    const f = r[1];
    if (!totals[f]) { totals[f] = { launches: 0, kills: 0, tournaments: 0, qredits: 0 }; months[f] = new Set(); }
    totals[f].launches += r[2];
    totals[f].kills += r[3];
    if (!months[f].has(r[0])) { totals[f].tournaments++; months[f].add(r[0]); }
    totals[f].qredits += (r[6] ?? 0);
  }
  const entries = Object.entries(totals).sort(([, a], [, b]) => b.launches - a.launches);
  if (entries.length <= 1) return null;
  const grand = entries.reduce((s, [, d]) => ({ launches: s.launches + d.launches, kills: s.kills + d.kills, tournaments: s.tournaments + d.tournaments, qredits: s.qredits + d.qredits }), { launches: 0, kills: 0, tournaments: 0, qredits: 0 });

  return (
    <div style={{ marginBottom: 12 }}>
      <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr>
            <th className="eyebrow" style={{ ...cellStyle, padding: "4px 8px", textAlign: "left" }}>Faction</th>
            <th className="eyebrow tabular" style={{ ...cellStyle, padding: "4px 8px", textAlign: "right" }}>Launches</th>
            <th className="eyebrow tabular" style={{ ...cellStyle, padding: "4px 8px", textAlign: "right" }}>Tournaments</th>
            <th className="eyebrow tabular" style={{ ...cellStyle, padding: "4px 8px", textAlign: "right" }}>Qredits</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([f, d]) => (
            <tr key={f}>
              <td style={{ ...cellStyle, padding: "4px 8px", color: factionColor(f) }}>{f}</td>
              <td className="tabular" style={{ ...cellStyle, padding: "4px 8px", textAlign: "right" }}>{d.launches.toLocaleString()}</td>
              <td className="tabular" style={{ ...cellStyle, padding: "4px 8px", textAlign: "right" }}>{d.tournaments}</td>
              <td className="tabular" style={{ ...cellStyle, padding: "4px 8px", textAlign: "right" }}>{d.qredits > 0 ? compact(d.qredits) : "—"}</td>
            </tr>
          ))}
          <tr style={{ fontWeight: 600 }}>
            <td style={{ ...cellStyle, padding: "4px 8px" }}>Total</td>
            <td className="tabular" style={{ ...cellStyle, padding: "4px 8px", textAlign: "right" }}>{grand.launches.toLocaleString()}</td>
            <td className="tabular" style={{ ...cellStyle, padding: "4px 8px", textAlign: "right" }}>{grand.tournaments}</td>
            <td className="tabular" style={{ ...cellStyle, padding: "4px 8px", textAlign: "right" }}>{grand.qredits > 0 ? compact(grand.qredits) : "—"}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

interface MonthVal { month: string; value: number }

function ChartYearLabels({ months, maxBarW }: { months: string[]; maxBarW?: number }) {
  let firstLabeled = false;
  return (
    <div style={{ display: "flex", gap: 1 }}>
      {months.map((m, i) => {
        const isJan = m.endsWith("-01");
        const show = isJan || (!firstLabeled && i === 0);
        if (show) firstLabeled = true;
        return (
          <div key={m} style={{ flex: "1 1 0", maxWidth: maxBarW, marginLeft: isJan ? 4 : 0 }}>
            {show ? <span className="tabular" style={{ fontSize: 7, color: "var(--text-dim)" }}>{m.slice(0, 4)}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function BarChart({ data, label }: { data: MonthVal[]; label: string }) {
  if (data.length === 0) return null;
  const maxV = Math.max(...data.map(d => d.value), 1);
  const h = 120;
  const maxBarW = 20;
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 2 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: h }}>
        {data.map(d => (
          <div key={d.month} title={`${d.month}: ${d.value.toLocaleString()}`} style={{
            flex: "1 1 0", maxWidth: maxBarW,
            height: (d.value / maxV) * (h - 14), background: "var(--text-dim)", opacity: 0.7, borderRadius: 1,
            marginLeft: d.month.endsWith("-01") ? 4 : 0,
          }} />
        ))}
      </div>
      <ChartYearLabels months={data.map(d => d.month)} maxBarW={maxBarW} />
    </div>
  );
}

function CumulativeLine({ data, label }: { data: MonthVal[]; label: string }) {
  if (data.length < 2) return null;
  let cumMax = 0;
  const cumVals = data.map(d => { cumMax += d.value; return cumMax; });
  const h = 120;
  const vbW = data.length * 2;
  const step = vbW / Math.max(data.length - 1, 1);
  const pts = cumVals.map((v, i) => `${i * step},${4 + (h - 18) - (v / cumMax) * (h - 18)}`).join(" ");

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 2 }}>{label}</div>
      <div style={{ position: "relative" }}>
        <svg width="100%" height={h} viewBox={`0 0 ${vbW} ${h}`} preserveAspectRatio="none" style={{ display: "block" }}>
          <polyline points={pts} fill="none" stroke="var(--text-dim)" strokeWidth={0.8} opacity={0.8} vectorEffect="non-scaling-stroke" />
          {data.map((d, i) => (
            <rect key={d.month} x={i * step - step / 2} y={0} width={step} height={h} fill="transparent">
              <title>{d.month}: {cumVals[i].toLocaleString()}</title>
            </rect>
          ))}
        </svg>
        <span className="tabular" style={{ position: "absolute", right: 0, top: 0, fontSize: 8, color: "var(--text-dim)" }}>{compact(cumMax)}</span>
      </div>
      <ChartYearLabels months={data.map(d => d.month)} />
    </div>
  );
}

function PlayerInfoRow({ data }: { data: PlayerMonthRow[] }) {
  const yearCounts = useMemo(() => {
    const months = new Set(data.map(r => r[0]));
    const yrs: Record<string, number> = {};
    for (const m of months) { const y = m.slice(0, 4); yrs[y] = (yrs[y] ?? 0) + 1; }
    return Object.entries(yrs).sort(([a], [b]) => a.localeCompare(b)).map(([y, c]) => ({ year: y, count: c }));
  }, [data]);
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginBottom: 12, flexWrap: "wrap" }}>
      <FactionBreakdown data={data} />
      <YearBars data={yearCounts} />
    </div>
  );
}

function YearBars({ data }: { data: { year: string; count: number }[] }) {
  if (data.length === 0) return null;
  const maxC = Math.max(...data.map(d => d.count), 1);
  const h = 120;
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 2 }}>Per year</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: h }}>
        {data.map(d => (
          <div key={d.year} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "1 1 0" }}>
            <div style={{ width: "100%", maxWidth: 24, height: (d.count / maxC) * (h - 20), background: "var(--text-dim)", borderRadius: 1 }}
              title={`${d.year}: ${d.count}`} />
            <span className="tabular" style={{ fontSize: 7, color: "var(--text-dim)" }}>{d.year}</span>
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

  if (byMonth.length === 0) return null;

  const launchData = byMonth.map(d => ({ month: d.month, value: d.launches }));
  const killData = byMonth.map(d => ({ month: d.month, value: d.kills }));
  const bestLaunches = launchData.reduce((a, b) => b.value > a.value ? b : a);
  const bestKills = killData.filter(d => d.value > 0).length > 0
    ? killData.reduce((a, b) => b.value > a.value ? b : a) : null;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <BarChart data={launchData} label="Launches" />
          <div style={{ fontSize: 10, color: "var(--text-dim)" }}>Peak: {bestLaunches.month} ({compact(bestLaunches.value)})</div>
        </div>
        <div>
          <BarChart data={killData} label="Kills" />
          {bestKills ? <div style={{ fontSize: 10, color: "var(--text-dim)" }}>Peak: {bestKills.month} ({compact(bestKills.value)})</div> : null}
        </div>
        <CumulativeLine data={launchData} label="Cumulative launches" />
        <CumulativeLine data={killData} label="Cumulative kills" />
      </div>
    </div>
  );
}

function PlayerDetailHeader({ name, factions, factionFilter, onFilterChange, onClose }: {
  name: string; factions: string[]; factionFilter: string | null;
  onFilterChange: (f: string) => void; onClose: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
      <button type="button" onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 16 }}>×</button>
      <span className="display" style={{ fontSize: 16 }}>{name}</span>
      <span style={{ fontSize: 12, color: factionFilter ? "var(--text-dim)" : "var(--text)", cursor: "pointer" }}
        onClick={() => onFilterChange("")}>All</span>
      {factions.map(f => (
        <span key={f}
          onClick={() => onFilterChange(f)}
          style={{ color: factionColor(f), fontSize: 12, cursor: "pointer", opacity: !factionFilter || factionFilter === f ? 1 : 0.4 }}
        >{f}</span>
      ))}
      {factions.length > 1 ? <span className="eyebrow" style={{ color: MAZ_AMBER, fontSize: 10 }}>mercenary</span> : null}
    </div>
  );
}

function PlayerDetailTable({ rows, detailSort, toggleDetailSort, dArrow }: {
  rows: PlayerMonthRow[]; detailSort: DetailSort;
  toggleDetailSort: (col: DetailSort) => void; dArrow: (col: DetailSort) => React.ReactNode;
}) {
  const dth: CSSProperties = { ...cellStyle, textAlign: "right" as const, cursor: "pointer", userSelect: "none" as const };
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
        <thead>
          <tr>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left", cursor: "pointer", userSelect: "none" }} onClick={() => toggleDetailSort("month")}>Month{dArrow("month")}</th>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Faction</th>
            <th className="eyebrow tabular" style={dth} onClick={() => toggleDetailSort("launches")}>Launches{dArrow("launches")}</th>
            <th className="eyebrow tabular" style={dth} onClick={() => toggleDetailSort("kills")}>Kills{dArrow("kills")}</th>
            <th className="eyebrow tabular" style={dth} onClick={() => toggleDetailSort("lost")}>Lost{dArrow("lost")}</th>
            <th className="eyebrow tabular" style={dth} onClick={() => toggleDetailSort("rank")}>Rank{dArrow("rank")}</th>
            <th className="eyebrow tabular" style={dth} onClick={() => toggleDetailSort("qredits")}>Qredits{dArrow("qredits")}</th>
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

  const [sortCol, setSortCol] = useState<SortCol>("launches");
  const [sortAsc, setSortAsc] = useState(false);
  const [filter, setFilter] = useState(playerParam ?? "");

  const toggleSort = (col: SortCol) => {
    if (col === sortCol) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(false); }
  };
  const arrow = (col: SortCol) => <span style={ARROW_SLOT}>{col === sortCol ? (sortAsc ? "▲" : "▼") : ""}</span>;

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
      <div className="display" style={{ fontSize: 13, marginBottom: 12 }}>Players</div>
      <PlayersTable
        filtered={filtered} filter={filter} onFilterChange={setFilter}
        sortCol={sortCol} toggleSort={toggleSort} arrow={arrow}
        onPlayerClick={onPlayerClick}
      />
      {playerParam ? <PlayerDetail name={playerParam} onClose={onPlayerClose} /> : null}
    </div>
  );
}

function PlayersTable({ filtered, filter, onFilterChange, sortCol, toggleSort, arrow, onPlayerClick }: {
  filtered: (AllTimePlayer & { rank: number })[];
  filter: string;
  onFilterChange: (v: string) => void;
  sortCol: SortCol;
  toggleSort: (col: SortCol) => void;
  arrow: (col: SortCol) => React.ReactNode;
  onPlayerClick: (name: string) => void;
}) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ position: "relative", display: "inline-block" }}>
          <input type="text" value={filter} onChange={e => onFilterChange(e.target.value)}
            placeholder="Filter by name..."
            style={{ background: "var(--ink-raised)", borderWidth: 1, borderStyle: "solid", borderColor: "var(--hairline-bright)", borderRadius: 3, padding: "4px 24px 4px 8px", color: "var(--text)", fontSize: 12, width: 180 }}
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
              <th className="eyebrow tabular" style={{ ...thStyle, textAlign: "right", cursor: "default" }}>First</th>
              <th className="eyebrow tabular" style={{ ...thStyle, textAlign: "right", cursor: "default" }}>Last</th>
              <th className="eyebrow tabular" style={{ ...thStyle, textAlign: "right" }} onClick={() => toggleSort("qredits")}>Qredits{arrow("qredits")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.name}>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right", color: "var(--text-dim)" }}>{r.rank}</td>
                <td style={{ ...cellStyle, cursor: "pointer" }} onClick={() => onPlayerClick(r.name)}>{r.name}</td>
                <td style={cellStyle}><FactionsCell factions={r.factions} unattributed={r.unattributed ?? 0} /></td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{r.launches.toLocaleString()}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{r.tournaments}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right", color: "var(--text-dim)" }}>{r.first_month}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right", color: "var(--text-dim)" }}>{r.last_month}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>
                  {r.qredits != null && r.qredits > 0 ? compact(r.qredits) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
