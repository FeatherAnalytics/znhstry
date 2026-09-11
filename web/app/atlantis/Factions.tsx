"use client";

import { useMemo, useState, useRef, useEffect, type CSSProperties } from "react";
import { FACTIONS as FACTION_DEFS } from "@/components/charts/palette";
import {
  factionColor,
  factionHex,
  compact,
  mergedTournaments,
  type AtlantisIndex,
  type AnyTournament,
  type FactionAllTime,
} from "./lib";

interface Props {
  index: AtlantisIndex;
}

const cellStyle: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--hairline)",
  whiteSpace: "nowrap",
};
const FACTIONS = ["Legion", "Swarm", "Faceless"] as const;
const FACTION_NAMES = FACTION_DEFS.map(f => f.label);

interface FM {
  month: string;
  stacking: number;
  battle: number;
  length: number;
  launches: Record<string, number>;
  kills: Record<string, number>;
  placements: [string, number, number][];
  zones: Record<string, number>;
  qredits: Record<string, number>;
  factionPlayers: Record<string, number>;
}

function buildFM(tournaments: AnyTournament[]): FM[] {
  return tournaments.map(t => {
    const length = t.stacking_days + t.battle_days;
    const zones: Record<string, number> = {};
    const qredits: Record<string, number> = {};
    for (const p of t.placements) { zones[p[0]] = p[1]; qredits[p[0]] = p[2]; }
    return {
      month: t.month, stacking: t.stacking_days, battle: t.battle_days, length,
      launches: t.launches ?? {}, kills: t.kills ?? {}, placements: t.placements,
      zones, qredits, factionPlayers: t.faction_players ?? {},
    };
  }).sort((a, b) => a.month.localeCompare(b.month));
}

type Mode = "tournament" | "perday" | "cumulative";

function YearLabels({ data }: { data: FM[] }) {
  let firstLabeled = false;
  return (
    <div style={{ display: "flex", gap: 1 }}>
      {data.map((d, i) => {
        const isJan = d.month.endsWith("-01");
        const showLabel = isJan || (!firstLabeled && i === 0);
        if (showLabel) firstLabeled = true;
        return (
          <div key={d.month} style={{ flex: "1 1 0", marginLeft: isJan ? 6 : 0, minWidth: 0 }}>
            {showLabel ? <span className="tabular" style={{ fontSize: 7, color: "var(--text-dim)" }}>{d.month.slice(0, 4)}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function useWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [w, setW] = useState(800);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    setW(ref.current.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function LineChart({ data, getVal, label, height }: {
  data: FM[]; getVal: (d: FM, f: string) => number | null; label: string; height: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const w = useWidth(containerRef);
  const maxV = Math.max(...FACTIONS.flatMap(f => data.map(d => getVal(d, f) ?? 0)), 1);
  const n = data.length;
  const step = w / Math.max(n - 1, 1);
  const ph = height - 18;

  return (
    <div style={{ marginBottom: 12 }} ref={containerRef}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 4 }}>{label}</div>
      <div style={{ position: "relative" }}>
        <span className="tabular" style={{ position: "absolute", top: 0, left: 0, fontSize: 8, color: "var(--text-dim)" }}>{compact(maxV)}</span>
        <svg width={w} height={height} style={{ display: "block" }}>
          {FACTIONS.map(f => {
            const segments: string[] = [];
            const singles: { x: number; y: number }[] = [];
            let cur = "";
            let curCount = 0;
            let curStart = 0;
            for (let i = 0; i < n; i++) {
              const v = getVal(data[i], f);
              if (v != null) {
                const x = i * step;
                const y = 4 + ph - (v / maxV) * ph;
                if (!cur) curStart = i;
                cur += (cur ? " " : "") + `${x},${y}`;
                curCount++;
              } else if (cur) {
                if (curCount === 1) singles.push({ x: curStart * step, y: parseFloat(cur.split(",")[1]) });
                else segments.push(cur);
                cur = ""; curCount = 0;
              }
            }
            if (cur) {
              if (curCount === 1) singles.push({ x: curStart * step, y: parseFloat(cur.split(",")[1]) });
              else segments.push(cur);
            }
            return [
              ...segments.map((seg, si) => (
                <polyline key={`${f}:${si}`} points={seg} fill="none" stroke={factionHex(f)} strokeWidth={1.5} opacity={0.8} />
              )),
              ...singles.map((pt, pi) => (
                <circle key={`${f}:dot:${pi}`} cx={pt.x} cy={pt.y} r={2} fill={factionHex(f)} opacity={0.8} />
              )),
            ];
          })}
          {data.map((d, i) => {
            const vals = FACTIONS.map(f => { const v = getVal(d, f); return v != null ? `${f}: ${compact(v)}` : null; }).filter(Boolean);
            return (
              <rect key={d.month} x={i * step - step / 2} y={0} width={step} height={height} fill="transparent">
                <title>{d.month}{"\n"}{vals.join("\n")}</title>
              </rect>
            );
          })}
        </svg>
      </div>
      <YearLabels data={data} />
    </div>
  );
}

function OverTime({ data, mode }: { data: FM[]; mode: Mode }) {
  const cumLaunches = useMemo(() => {
    const acc: Record<string, number> = {};
    return data.map(d => {
      const row: Record<string, number> = {};
      for (const f of FACTIONS) { acc[f] = (acc[f] ?? 0) + (d.launches[f] ?? 0); row[f] = acc[f]; }
      return row;
    });
  }, [data]);

  const cumKills = useMemo(() => {
    const acc: Record<string, number> = {};
    return data.map(d => {
      const row: Record<string, number> = {};
      for (const f of FACTIONS) {
        if (f in d.kills) acc[f] = (acc[f] ?? 0) + (d.kills[f] ?? 0);
        row[f] = acc[f] ?? 0;
      }
      return row;
    });
  }, [data]);

  const cumQredits = useMemo(() => {
    const acc: Record<string, number> = {};
    return data.map(d => {
      const row: Record<string, number> = {};
      for (const f of FACTIONS) { acc[f] = (acc[f] ?? 0) + (d.qredits[f] ?? 0); row[f] = acc[f]; }
      return row;
    });
  }, [data]);

  const launchVal = (d: FM, f: string, i: number): number | null => {
    if (mode === "cumulative") return cumLaunches[i]?.[f] ?? 0;
    const v = d.launches[f] ?? 0;
    return mode === "perday" && d.length > 0 ? v / d.length : v;
  };

  const killVal = (d: FM, f: string, i: number): number | null => {
    if (mode === "cumulative") return cumKills[i]?.[f] ?? null;
    if (!(f in d.kills)) return null;
    const v = d.kills[f] ?? 0;
    return mode === "perday" && d.battle > 0 ? v / d.battle : mode === "perday" ? null : v;
  };

  return (
    <div style={{ marginBottom: 24 }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>Over time</div>
      <LineChart data={data} label={mode === "perday" ? "Launches /day" : "Launches"} height={160} getVal={(d, f) => launchVal(d, f, data.indexOf(d))} />
      <LineChart data={data} label={mode === "perday" ? "Kills /battle day" : "Kills"} height={160} getVal={(d, f) => killVal(d, f, data.indexOf(d))} />
      {data.some(d => Object.keys(d.factionPlayers).length > 0) ? (
        <LineChart data={data} label={mode === "perday" ? "Players /day" : "Players"} height={160} getVal={(d, f) => {
          const v = d.factionPlayers[f];
          if (v == null) return null;
          if (mode === "perday" && d.length > 0) return v / d.length;
          if (mode === "cumulative") {
            let sum = 0;
            for (const dd of data) {
              if (dd.month > d.month) break;
              sum += dd.factionPlayers[f] ?? 0;
            }
            return sum;
          }
          return v;
        }} />
      ) : null}
      <LineChart data={data} label="Qredits (cumulative)" height={160} getVal={(_, f) => {
        const i = data.indexOf(_);
        return cumQredits[i]?.[f] ?? 0;
      }} />
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
    <div style={{ flex: 1, minWidth: 120 }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 40 }}>
        {keys.map(k => (
          <div key={k} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{ width: 16, height: ((counts[k] ?? 0) / max) * 32, background: "var(--text-dim)", borderRadius: 1 }} title={`${k}: ${counts[k] ?? 0}`} />
            <span className="tabular" style={{ fontSize: 9, color: "var(--text-dim)" }}>{k}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FactionHistogram({ data, field, label, perDay }: { data: FM[]; field: "zones" | "kills"; label: string; perDay: boolean }) {
  const maxZone = field === "zones" ? 19 : -1;
  const isZones = field === "zones";
  const entries: { faction: string; value: number }[] = [];
  for (const d of data) {
    for (const f of FACTIONS) {
      if (field === "kills" && !(f in d.kills)) continue;
      let v = (isZones ? d.zones : d.kills)[f] ?? 0;
      if (perDay && field === "kills" && d.battle > 0) v = v / d.battle;
      else if (perDay && field === "kills") continue;
      entries.push({ faction: f, value: v });
    }
  }
  if (entries.length === 0) return null;

  const bucketCount = isZones ? maxZone + 1 : 10;
  const vals = entries.map(e => e.value);
  const min = isZones ? 0 : Math.min(...vals);
  const max2 = isZones ? maxZone : Math.max(...vals);
  const step = isZones ? 1 : Math.max(1, Math.ceil((max2 - min) / bucketCount));
  const buckets: Record<string, number[]> = {};
  for (const f of FACTIONS) buckets[f] = new Array(bucketCount).fill(0);
  for (const e of entries) {
    const idx = isZones ? e.value : Math.min(Math.floor((e.value - min) / step), bucketCount - 1);
    if (idx >= 0 && idx < bucketCount) buckets[e.faction][idx]++;
  }
  const maxStack = Math.max(...Array.from({ length: bucketCount }, (_, i) => FACTIONS.reduce((s, f) => s + buckets[f][i], 0)), 1);

  return (
    <div style={{ flex: 1, minWidth: 180 }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 48 }}>
        {Array.from({ length: bucketCount }, (_, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
            <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
              {FACTIONS.map(f => {
                const c = buckets[f][i];
                return c > 0 ? <div key={f} style={{ width: "100%", height: (c / maxStack) * 36, background: factionHex(f), opacity: 0.7 }} title={`${f}: ${c}`} /> : null;
              })}
            </div>
            {(isZones ? i % 2 === 0 : true) ? <span className="tabular" style={{ fontSize: 7, color: "var(--text-dim)" }}>{isZones ? i : compact(min + i * step)}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

interface GroupedBarsProps {
  data: FM[];
  xField: "length" | "battle";
  yFn: (d: FM, f: string) => number | null;
  label: string;
  xLabel: string;
}

function GroupedBars({ data, xField, yFn, label, xLabel }: GroupedBarsProps) {
  const groups: Record<number, Record<string, { sum: number; count: number }>> = {};
  for (const d of data) {
    const x = d[xField];
    if (!groups[x]) groups[x] = {};
    for (const f of FACTIONS) {
      const y = yFn(d, f);
      if (y == null) continue;
      if (!groups[x][f]) groups[x][f] = { sum: 0, count: 0 };
      groups[x][f].sum += y;
      groups[x][f].count++;
    }
  }
  const xVals = Object.keys(groups).map(Number).sort((a, b) => a - b)
    .filter(x => FACTIONS.some(f => groups[x][f]?.count > 0));
  if (xVals.length === 0) return null;
  const means: Record<number, Record<string, number>> = {};
  const ns: Record<number, number> = {};
  let maxMean = 1;
  for (const x of xVals) {
    means[x] = {};
    ns[x] = 0;
    for (const f of FACTIONS) {
      const g = groups[x][f];
      if (g && g.count > 0) { means[x][f] = g.sum / g.count; maxMean = Math.max(maxMean, means[x][f]); ns[x] = Math.max(ns[x], g.count); }
    }
  }

  return (
    <div style={{ flex: 1, minWidth: 160 }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", height: 80 }}>
        {xVals.map(x => (
          <div key={x} style={{ flex: "1 1 0", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end" }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 56 }}>
              {FACTIONS.map(f => {
                const m = means[x][f];
                return m != null ? (
                  <div key={f} style={{ width: 12, height: (m / maxMean) * 52, background: factionHex(f), borderRadius: 1 }}
                    title={`${f}: ${compact(m)} mean (n=${groups[x][f].count})`} />
                ) : null;
              })}
            </div>
            <span className="tabular" style={{ fontSize: 9, color: "var(--text-dim)" }}>{x}</span>
            <span className="tabular" style={{ fontSize: 7, color: "var(--text-dim)" }}>n={ns[x]}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 9, color: "var(--text-dim)", marginTop: 4, textAlign: "center" }}>{xLabel}</div>
    </div>
  );
}

function StandingsTable({ factions, tournaments }: { factions: Record<string, FactionAllTime>; tournaments: AnyTournament[] }) {
  const counts: Record<string, [number, number, number]> = {};
  for (const f of FACTION_NAMES) counts[f] = [0, 0, 0];
  for (const t of tournaments) {
    for (let i = 0; i < 3; i++) {
      const p = t.placements[i];
      if (p && counts[p[0]]) counts[p[0]][i]++;
    }
  }
  const total = Math.max(tournaments.length, 1);

  return (
    <div style={{ flex: 1, minWidth: 240 }}>
      <div className="eyebrow" style={{ marginBottom: 4 }}>Standings</div>
      <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Faction</th>
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>1st</th>
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>2nd</th>
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>3rd</th>
            <th style={cellStyle} />
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Launches</th>
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Qredits</th>
          </tr>
        </thead>
        <tbody>
          {FACTION_NAMES.map(f => (
            <tr key={f}>
              <td style={{ ...cellStyle, color: factionColor(f), fontWeight: 600 }}>{f}</td>
              <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{counts[f][0]}</td>
              <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{counts[f][1]}</td>
              <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{counts[f][2]}</td>
              <td style={cellStyle}>
                <span style={{ display: "inline-flex", gap: 3 }}>
                  {counts[f].map((c, i) => (
                    <span key={i} style={{ width: Math.max(2, (c / total) * 50), height: 8, background: "var(--text-dim)", borderRadius: 1 }} title={`${["1st", "2nd", "3rd"][i]}: ${c}`} />
                  ))}
                </span>
              </td>
              <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{compact(factions[f]?.launches ?? 0)}</td>
              <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{compact(factions[f]?.qredits ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StreaksTable({ data }: { data: FM[] }) {
  const streaks: Record<string, Record<string, { current: number; longest: number }>> = {};
  for (const f of FACTIONS) {
    streaks[f] = {};
    for (const p of ["1st", "2nd", "3rd"]) streaks[f][p] = { current: 0, longest: 0 };
  }
  for (const place of [0, 1, 2]) {
    const label = ["1st", "2nd", "3rd"][place];
    for (const f of FACTIONS) {
      let run = 0, best = 0;
      for (const d of data) {
        if (d.placements[place]?.[0] === f) { run++; best = Math.max(best, run); } else run = 0;
      }
      streaks[f][label] = { current: run, longest: best };
    }
  }
  return (
    <div style={{ flex: 1, minWidth: 240 }}>
      <div className="eyebrow" style={{ marginBottom: 4 }}>Streaks</div>
      <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }} rowSpan={2}>Faction</th>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "center" }} colSpan={3}>Current</th>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "center" }} colSpan={3}>Best</th>
          </tr>
          <tr>
            {["1st", "2nd", "3rd", "1st", "2nd", "3rd"].map((p, i) => (
              <th key={`${p}${i}`} className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>{p}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FACTIONS.map(f => (
            <tr key={f}>
              <td style={{ ...cellStyle, color: factionColor(f), fontWeight: 600 }}>{f}</td>
              {["1st", "2nd", "3rd"].map(p => <td key={`c${p}`} className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{streaks[f][p].current}</td>)}
              {["1st", "2nd", "3rd"].map(p => <td key={`l${p}`} className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{streaks[f][p].longest}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const section: CSSProperties = { padding: "16px 16px 24px" };
const modeLabels: Record<Mode, string> = { tournament: "Per tournament", perday: "Per day", cumulative: "Cumulative" };

export default function Factions({ index }: Props) {
  const tournaments = useMemo(() => mergedTournaments(index), [index]);
  const data = useMemo(() => buildFM(tournaments), [tournaments]);
  const [mode, setMode] = useState<Mode>("tournament");
  const perDay = mode === "perday";

  return (
    <div style={section}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div className="display" style={{ fontSize: 13 }}>Factions</div>
        <div style={{ display: "flex", gap: 4 }}>
          {(["tournament", "perday", "cumulative"] as Mode[]).map(m => (
            <button key={m} type="button" onClick={() => setMode(m)}
              style={{ padding: "3px 10px", borderRadius: 3, fontSize: 11, cursor: "pointer", background: m === mode ? "var(--hairline)" : "transparent", borderWidth: 1, borderStyle: "solid", borderColor: m === mode ? "var(--text-dim)" : "var(--hairline-bright)", color: "var(--text)" }}
            >{modeLabels[m]}</button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 24 }}>
        <StandingsTable factions={index.all_time.factions} tournaments={tournaments} />
        <StreaksTable data={data} />
      </div>

      <OverTime data={data} mode={mode} />

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 24 }}>
        <FactionHistogram data={data} field="zones" label="Zones held" perDay={false} />
        <FactionHistogram data={data} field="kills" label={perDay ? "Kills /battle day" : "Kills"} perDay={perDay} />
      </div>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 24 }}>
        <Histogram values={data.map(d => d.stacking)} label="Stacking days" rangeMin={0} />
        <Histogram values={data.map(d => d.battle)} label="Battle days" rangeMin={1} />
      </div>

      <div className="eyebrow" style={{ marginBottom: 8 }}>Length vs outcome</div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24, overflowX: "auto" }}>
        <GroupedBars data={data} xField="length" yFn={(d, f) => d.zones[f] ?? 0} label="Zones held" xLabel="length (days)" />
        <GroupedBars data={data} xField="length" yFn={(d, f) => d.length > 0 ? (d.launches[f] ?? 0) / d.length : null} label="Launches /day" xLabel="length (days)" />
        <GroupedBars data={data} xField="battle" yFn={(d, f) => d.battle > 0 && f in d.kills ? (d.kills[f] ?? 0) / d.battle : null} label="Kills /battle day" xLabel="battle days" />
      </div>
    </div>
  );
}
