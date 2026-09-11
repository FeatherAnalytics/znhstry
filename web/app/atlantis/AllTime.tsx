"use client";

import { useMemo, useState, useEffect, useRef, useCallback, type CSSProperties } from "react";
import { useChartHover, useBarHover } from "./useChartHover";
import { useWidth, YearLabels } from "./chartUtils";
import { useSearchParams, useRouter } from "next/navigation";
import { BASE } from "@/lib/dataOrigin";
import { FACTIONS as FACTION_DEFS } from "@/components/charts/palette";
import {
  factionColor,
  factionHex,
  compact,
  fetchPlayersDetail,
  type AtlantisIndex,
  type AllTimePlayer,
  type FactionDetail,
  type PlayerMonthRow,
} from "./lib";

const FACTION_ORDER = FACTION_DEFS.map(f => f.label);

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
  if (unattributed > 0) parts.push(`+ ${unattributed.toLocaleString()} not yet attributed`);
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
    else { setDetailSort(col); setDetailAsc(false); }
  };
  const dArrow = (col: DetailSort) => <span style={ARROW_SLOT}>{col === detailSort ? (detailAsc ? "▲" : "▼") : ""}</span>;

  return (
    <div style={{ borderTop: "2px solid var(--hairline-bright)", padding: "16px 16px 24px" }}>
      <PlayerDetailHeader
        player={{ name, factions }}
        filter={{ value: factionFilter, onChange: f => setFactionFilter(factionFilter === f ? null : f) }}
        onClose={onClose}
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
              <td style={{ ...cellStyle, padding: "4px 8px", color: factionColor(f) }}>{f === "Unconfirmed" ? "Not yet attributed" : f}</td>
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

function barHeight(v: number, max: number, h: number): number {
  return v > 0 ? (v / max) * (h - 14) : 0;
}

function median(nums: number[]): number {
  const sorted = nums.filter(v => v > 0).sort((a, b) => a - b);
  return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
}

function yearGap(m: string): number { return m.endsWith("-01") ? 4 : 0; }

interface FactionMonthVal { month: string; total: number; byFaction: Record<string, number> }

function FactionBarChart(props: { data: FactionMonthVal[]; label: string; allMonths: string[] }) {
  if (props.data.length === 0) return null;
  const months = props.allMonths;
  const valMap = new Map(props.data.map(d => [d.month, d]));
  const maxV = Math.max(...props.data.map(d => d.total), 1);
  const medianV = median(props.data.map(d => d.total));
  const h = 240;
  const maxBarW = 20;
  const bar = useBarHover(months.length);
  const hm = bar.index != null ? months[bar.index] : null;
  const hd = hm ? valMap.get(hm) : null;
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span className="eyebrow" style={{ fontSize: 10 }}>{props.label}</span>
        <span className="tabular" style={{ fontSize: 8, color: "var(--text-dim)" }}>{compact(maxV)}</span>
      </div>
      <div style={{ position: "relative" }}>
        <div style={{ position: "absolute", top: `${((maxV - medianV) / maxV) * (h - 14)}px`, left: 0, right: 0, borderTop: "1px dashed var(--hairline)", pointerEvents: "none" }}>
          <span className="tabular" style={{ fontSize: 7, color: "var(--text-dim)", position: "absolute", left: 0, top: -8, background: "var(--ink)", padding: "0 4px", borderRadius: 2 }}>median {compact(medianV)}</span>
        </div>
        <div ref={bar.ref} onMouseMove={bar.onMouseMove} onMouseLeave={bar.onMouseLeave}
          style={{ display: "flex", alignItems: "flex-end", gap: 1, height: h }}>
          {months.map((m, i) => {
            const entry = valMap.get(m);
            const total = entry?.total ?? 0;
            const opacity = bar.index != null && bar.index !== i ? 0.4 : 0.8;
            return (
              <div key={m} style={{ flex: "1 1 0", maxWidth: maxBarW, height: barHeight(total, maxV, h), display: "flex", flexDirection: "column", marginLeft: yearGap(m), borderRadius: 1, overflow: "hidden" }}>
                {entry ? FACTION_ORDER.map(f => {
                  const v = entry.byFaction[f] ?? 0;
                  return v > 0 ? <div key={f} style={{ flex: `${v} 0 0`, background: factionHex(f), opacity }} /> : null;
                }).concat(
                  (() => { const grey = (entry.byFaction["Unconfirmed"] ?? 0); return grey > 0 ? [<div key="grey" style={{ flex: `${grey} 0 0`, background: "#7c8798", opacity }} />] : []; })()
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <YearLabels months={months} maxBarW={maxBarW} />
      <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2, minHeight: 16 }}>
        {hd ? (
          <>
            <span style={{ fontWeight: 600 }}>{hm}</span>: {hd.total.toLocaleString()}
            {FACTION_ORDER.map(f => {
              const v = hd.byFaction[f];
              return v ? <span key={f} style={{ marginLeft: 6, color: factionHex(f) }}>{compact(v)}</span> : null;
            })}
            {hd.byFaction["Unconfirmed"] ? <span style={{ marginLeft: 6, color: "#7c8798" }}>{compact(hd.byFaction["Unconfirmed"])}</span> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}


function CumulativeLine({ data, label, allMonths }: { data: MonthVal[]; label: string; allMonths?: string[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const w = useWidth(containerRef);
  if (data.length < 2) return null;
  const months = allMonths ?? data.map(d => d.month);
  const valMap = new Map(data.map(d => [d.month, d.value]));
  let cumMax = 0;
  const cumVals = months.map(m => { cumMax += valMap.get(m) ?? 0; return cumMax; });
  const h = 240;
  const step = w / Math.max(months.length - 1, 1);
  const ph = h - 18;
  const pts = cumVals.map((v, i) => `${i * step},${4 + ph - (v / cumMax) * ph}`).join(" ");
  const halfY = 4 + ph - (0.5 * ph);
  const { hover, onMouseMove, onMouseLeave } = useChartHover(months.length, step);

  return (
    <div style={{ flex: 1, minWidth: 0 }} ref={containerRef}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 2 }}>{label}</div>
      <div style={{ position: "relative" }}>
        <svg width={w} height={h} style={{ display: "block" }} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}>
          <line x1={0} x2={w} y1={halfY} y2={halfY} stroke="var(--hairline)" strokeWidth={1} strokeDasharray="3,3" />
          <polyline points={pts} fill="none" stroke="var(--text)" strokeWidth={1.5} opacity={0.8} />
          {(() => {
            const halfTarget = cumMax / 2;
            for (let i = 0; i < cumVals.length; i++) {
              if (cumVals[i] >= halfTarget) {
                const cx = i * step;
                return (
                  <g>
                    <line x1={cx} x2={cx} y1={halfY} y2={4 + ph} stroke="var(--text)" strokeWidth={0.5} opacity={0.4} />
                    <circle cx={cx} cy={halfY} r={2.5} fill="var(--text)" opacity={0.8} />
                  </g>
                );
              }
            }
            return null;
          })()}
          {hover ? (
            <>
              <line x1={hover.x} x2={hover.x} y1={0} y2={h} stroke="var(--text-dim)" strokeWidth={1} opacity={0.3} />
              <circle cx={hover.x} cy={4 + ph - (cumVals[hover.index] / cumMax) * ph} r={3} fill="var(--text)" />
            </>
          ) : null}
        </svg>
        <span className="tabular" style={{ position: "absolute", left: 0, top: 0, fontSize: 8, color: "var(--text-dim)" }}>{compact(cumMax)}</span>
        <span className="tabular" style={{ position: "absolute", left: 0, top: `${(halfY / h) * 100}%`, fontSize: 7, color: "var(--text-dim)" }}>{compact(cumMax / 2)}</span>
      </div>
      <YearLabels months={months} />
      <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2, minHeight: 16 }}>{hover ? <><span style={{ fontWeight: 600 }}>{months[hover.index]}</span>: {cumVals[hover.index].toLocaleString()}</> : null}</div>
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
  const currentYear = new Date().getUTCFullYear();
  const allYears: string[] = [];
  for (let y = 2014; y <= currentYear; y++) allYears.push(String(y));
  const countMap = new Map(data.map(d => [d.year, d.count]));
  const maxC = Math.max(...data.map(d => d.count), 1);
  const h = 160;
  return (
    <div style={{ flex: "1 1 0", minWidth: 0 }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 2 }}>Per year</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: h }}>
        {allYears.map(y => {
          const c = countMap.get(y) ?? 0;
          return (
            <div key={y} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "1 1 0", minWidth: 20 }}>
              <div style={{ width: "80%", maxWidth: 20, height: c > 0 ? (c / maxC) * (h - 20) : 0, background: "var(--text-dim)", borderRadius: 1 }}
                title={c > 0 ? `${y}: ${c}` : y} />
              <span className="tabular" style={{ fontSize: 7, color: "var(--text-dim)" }}>{y}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function buildFactionMonthData(rows: PlayerMonthRow[], field: 2 | 3): FactionMonthVal[] {
  const map: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const m = r[0];
    const f = r[1];
    if (!map[m]) map[m] = {};
    map[m][f] = (map[m][f] ?? 0) + r[field];
  }
  return Object.entries(map).sort(([a], [b]) => a.localeCompare(b)).map(([m, byFaction]) => {
    const total = Object.values(byFaction).reduce((s, v) => s + v, 0);
    return { month: m, total, byFaction };
  });
}

function PlayerCharts({ rows }: { rows: PlayerMonthRow[] }) {
  const launchData = useMemo(() => buildFactionMonthData(rows, 2), [rows]);
  const killData = useMemo(() => buildFactionMonthData(rows, 3), [rows]);

  if (launchData.length === 0) return null;

  const allMonths = launchData.map(d => d.month);
  const launchMV = launchData.map(d => ({ month: d.month, value: d.total }));
  const killMV = killData.map(d => ({ month: d.month, value: d.total }));
  const bestLaunches = launchMV.reduce((a, b) => b.value > a.value ? b : a);
  const bestKills = killMV.filter(d => d.value > 0).length > 0
    ? killMV.reduce((a, b) => b.value > a.value ? b : a) : null;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <div>
          <FactionBarChart data={launchData} label="Launches" allMonths={allMonths} />
          <div style={{ fontSize: 10, color: "var(--text-dim)" }}>Peak: {bestLaunches.month} ({compact(bestLaunches.value)})</div>
        </div>
        <div>
          <FactionBarChart data={killData} label="Kills" allMonths={allMonths} />
          {bestKills ? <div style={{ fontSize: 10, color: "var(--text-dim)" }}>Peak: {bestKills.month} ({compact(bestKills.value)})</div> : null}
        </div>
        <CumulativeLine data={launchMV} label="Cumulative launches" allMonths={allMonths} />
        <CumulativeLine data={killMV} label="Cumulative kills" allMonths={allMonths} />
      </div>
    </div>
  );
}

interface DetailHeaderProps {
  player: { name: string; factions: string[] };
  filter: { value: string | null; onChange: (f: string) => void };
  onClose: () => void;
}

function PlayerDetailHeader({ player, filter, onClose }: DetailHeaderProps) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
      <button type="button" onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 16 }}>×</button>
      <span className="display" style={{ fontSize: 16 }}>{player.name}</span>
      <span style={{ fontSize: 12, color: filter.value ? "var(--text-dim)" : "var(--text)", cursor: "pointer" }}
        onClick={() => filter.onChange("")}>All</span>
      {player.factions.map(f => (
        <span key={f}
          onClick={() => filter.onChange(f)}
          style={{ color: factionColor(f), fontSize: 12, cursor: "pointer", opacity: !filter.value || filter.value === f ? 1 : 0.4 }}
        >{f}</span>
      ))}
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
