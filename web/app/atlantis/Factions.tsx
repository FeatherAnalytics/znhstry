"use client";

import { useMemo, useState, type CSSProperties } from "react";
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

const section: CSSProperties = { padding: "16px 16px 24px" };
const cellStyle: CSSProperties = {
  padding: "12px 10px",
  borderBottom: "1px solid var(--hairline)",
  whiteSpace: "nowrap",
};
const FACTIONS = ["Legion", "Swarm", "Faceless"] as const;
const FACTION_NAMES = FACTION_DEFS.map(f => f.label);
const SHORTFALL_START = "2019-07";
const SHORTFALL_END = "2019-09";

interface FactionMonth {
  month: string;
  stacking: number;
  battle: number;
  length: number;
  launches: Record<string, number>;
  kills: Record<string, number>;
  placements: [string, number, number][];
  zones: Record<string, number>;
  qredits: Record<string, number>;
  inShortfall: boolean;
}

function buildFactionMonths(tournaments: AnyTournament[]): FactionMonth[] {
  return tournaments.map(t => {
    const length = t.stacking_days + t.battle_days;
    const zones: Record<string, number> = {};
    const qredits: Record<string, number> = {};
    for (const p of t.placements) {
      zones[p[0]] = p[1];
      qredits[p[0]] = p[2];
    }
    return {
      month: t.month,
      stacking: t.stacking_days,
      battle: t.battle_days,
      length,
      launches: t.launches ?? {},
      kills: t.kills ?? {},
      placements: t.placements,
      zones,
      qredits,
      inShortfall: t.month >= SHORTFALL_START && t.month <= SHORTFALL_END,
    };
  }).sort((a, b) => a.month.localeCompare(b.month));
}

function yearMarkers(data: FactionMonth[]): { indices: number[]; labels: { idx: number; label: string }[] } {
  const indices: number[] = [];
  const labels: { idx: number; label: string }[] = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i].month.endsWith("-01")) {
      indices.push(i);
      labels.push({ idx: i, label: data[i].month.slice(0, 4) });
    }
  }
  return { indices, labels };
}

function factionVal(d: FactionMonth, field: "launches" | "kills" | "qredits", f: string, perDay: boolean, divideBy: "length" | "battle"): number | null {
  const map = field === "qredits" ? d.qredits : d[field];
  if (field === "kills" && !(f in map)) return null;
  const v = map[f] ?? 0;
  if (!perDay) return v;
  const div = divideBy === "battle" ? d.battle : d.length;
  return div > 0 ? v / div : null;
}

function OverTimeLines({ data, field, perDay, label, divideBy }: {
  data: FactionMonth[];
  field: "launches" | "kills" | "qredits";
  perDay: boolean;
  label: string;
  divideBy: "length" | "battle";
}) {
  const h = 100;
  const pad = { top: 4, bottom: 16 };
  const ph = h - pad.top - pad.bottom;
  const n = data.length;
  const vbW = n * 2;
  const step = vbW / Math.max(n - 1, 1);
  const { indices: yearIdx, labels: yearLabels } = yearMarkers(data);

  const maxV = Math.max(
    ...FACTIONS.flatMap(f => data.map(d => factionVal(d, field, f, perDay, divideBy) ?? 0)),
    1,
  );

  return (
    <div style={{ marginBottom: 12 }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 4 }}>{label}{perDay ? " /day" : ""}</div>
      <svg width="100%" height={h} viewBox={`0 0 ${vbW} ${h}`} preserveAspectRatio="none" style={{ display: "block" }}>
        {data.some(d => d.inShortfall) && field === "launches" ? (
          <rect
            x={data.findIndex(d => d.inShortfall) * step}
            y={0}
            width={(data.filter(d => d.inShortfall).length) * step}
            height={h - pad.bottom}
            fill="var(--text-dim)" opacity={0.08}
          />
        ) : null}
        {yearIdx.map(i => (
          <line key={i} x1={i * step} x2={i * step} y1={0} y2={h - pad.bottom} stroke="var(--hairline)" strokeWidth={0.3} />
        ))}
        {FACTIONS.map(f => {
          const segments: string[] = [];
          let current = "";
          for (let i = 0; i < n; i++) {
            const v = factionVal(data[i], field, f, perDay, divideBy);
            if (v != null) {
              const x = i * step;
              const y = pad.top + ph - (v / maxV) * ph;
              current += (current ? " " : "") + `${x},${y}`;
            } else if (current) {
              segments.push(current);
              current = "";
            }
          }
          if (current) segments.push(current);
          return segments.map((seg, si) => (
            <polyline key={`${f}:${si}`} points={seg} fill="none" stroke={factionHex(f)} strokeWidth={0.8} opacity={0.8} vectorEffect="non-scaling-stroke" />
          ));
        })}
      </svg>
      <div style={{ display: "flex", position: "relative", height: 12 }}>
        {yearLabels.map(({ idx, label: yr }) => (
          <span key={yr + idx} className="tabular"
            style={{ position: "absolute", left: `${(idx / Math.max(n - 1, 1)) * 100}%`, fontSize: 9, color: "var(--text-dim)" }}
          >{yr}</span>
        ))}
      </div>
    </div>
  );
}

function OverTime({ data }: { data: FactionMonth[] }) {
  const [perDay, setPerDay] = useState(false);
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
        <div className="eyebrow">Over time</div>
        <label style={{ fontSize: 11, color: "var(--text-dim)", cursor: "pointer" }}>
          <input type="checkbox" checked={perDay} onChange={e => setPerDay(e.target.checked)} style={{ marginRight: 4 }} />
          per day
        </label>
      </div>
      <OverTimeLines data={data} field="launches" perDay={perDay} label="Launches" divideBy="length" />
      <OverTimeLines data={data} field="kills" perDay={perDay} label="Kills" divideBy="battle" />
      <OverTimeLines data={data} field="qredits" perDay={perDay} label="Qredits" divideBy="length" />
    </div>
  );
}

function ZonesHistogram({ data }: { data: FactionMonth[] }) {
  const maxZone = 19;
  const buckets: Record<string, number[]> = {};
  for (const f of FACTIONS) buckets[f] = new Array(maxZone + 1).fill(0);
  for (const d of data) {
    for (const f of FACTIONS) {
      const v = d.zones[f] ?? 0;
      if (v >= 0 && v <= maxZone) buckets[f][v]++;
    }
  }
  const maxStack = Math.max(
    ...Array.from({ length: maxZone + 1 }, (_, i) => FACTIONS.reduce((s, f) => s + buckets[f][i], 0)),
    1,
  );
  return (
    <div style={{ flex: 1, minWidth: 180 }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 4 }}>Zones held</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 48 }}>
        {Array.from({ length: maxZone + 1 }, (_, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
            <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
              {FACTIONS.map(f => {
                const count = buckets[f][i];
                return count > 0 ? (
                  <div key={f} style={{ width: "100%", height: (count / maxStack) * 36, background: factionHex(f), opacity: 0.7 }}
                    title={`${f}: ${count} at ${i} zones`} />
                ) : null;
              })}
            </div>
            {i % 2 === 0 ? <span className="tabular" style={{ fontSize: 7, color: "var(--text-dim)" }}>{i}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function collectValues(data: FactionMonth[], field: "kills" | "qredits"): { faction: string; value: number }[] {
  const result: { faction: string; value: number }[] = [];
  for (const d of data) {
    for (const f of FACTIONS) {
      if (field === "kills" && !(f in d.kills)) continue;
      result.push({ faction: f, value: (field === "kills" ? d.kills : d.qredits)[f] ?? 0 });
    }
  }
  return result;
}

function ValueHistogram({ data, field, label }: { data: FactionMonth[]; field: "kills" | "qredits"; label: string }) {
  const bucketCount = 10;
  const entries = collectValues(data, field);
  if (entries.length === 0) return null;
  const vals = entries.map(e => e.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const step = Math.max(1, Math.ceil((max - min) / bucketCount));
  const buckets: Record<string, number[]> = {};
  for (const f of FACTIONS) buckets[f] = new Array(bucketCount).fill(0);
  for (const e of entries) {
    const idx = Math.min(Math.floor((e.value - min) / step), bucketCount - 1);
    buckets[e.faction][idx]++;
  }
  const maxStack = Math.max(
    ...Array.from({ length: bucketCount }, (_, i) => FACTIONS.reduce((s, f) => s + buckets[f][i], 0)),
    1,
  );

  return (
    <div style={{ flex: 1, minWidth: 180 }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 48 }}>
        {Array.from({ length: bucketCount }, (_, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
            <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
              {FACTIONS.map(f => {
                const count = buckets[f][i];
                return count > 0 ? (
                  <div key={f} style={{ width: "100%", height: (count / maxStack) * 36, background: factionHex(f), opacity: 0.7 }}
                    title={`${f}: ${count}`} />
                ) : null;
              })}
            </div>
            <span className="tabular" style={{ fontSize: 7, color: "var(--text-dim)" }}>{compact(min + i * step)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Distributions({ data }: { data: FactionMonth[] }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>Distributions</div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <ZonesHistogram data={data} />
        <ValueHistogram data={data} field="kills" label="Kills" />
        <ValueHistogram data={data} field="qredits" label="Qredits" />
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

function Streaks({ data }: { data: FactionMonth[] }) {
  const streaks: Record<string, Record<string, { current: number; longest: number }>> = {};
  for (const f of FACTIONS) {
    streaks[f] = {};
    for (const place of ["1st", "2nd", "3rd"]) streaks[f][place] = { current: 0, longest: 0 };
  }
  for (const place of [0, 1, 2]) {
    const label = ["1st", "2nd", "3rd"][place];
    for (const f of FACTIONS) {
      let run = 0;
      let best = 0;
      for (const d of data) {
        if (d.placements[place]?.[0] === f) { run++; best = Math.max(best, run); }
        else run = 0;
      }
      streaks[f][label] = { current: run, longest: best };
    }
  }
  return (
    <div style={{ marginBottom: 24 }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>Streaks</div>
      <div style={{ overflowX: "auto" }}>
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
                {["1st", "2nd", "3rd"].map(p => (
                  <td key={`c${p}`} className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{streaks[f][p].current}</td>
                ))}
                {["1st", "2nd", "3rd"].map(p => (
                  <td key={`l${p}`} className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{streaks[f][p].longest}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DayHistograms({ data }: { data: FactionMonth[] }) {
  const stackingDays = data.map(d => d.stacking);
  const battleDays = data.map(d => d.battle);
  return (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 24 }}>
      <Histogram values={stackingDays} label="Stacking days" rangeMin={0} />
      <Histogram values={battleDays} label="Battle days" rangeMin={1} />
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
            <div style={{ width: 16, height: ((counts[k] ?? 0) / max) * 32, background: "var(--text-dim)", borderRadius: 1 }}
              title={`${k}: ${counts[k] ?? 0}`} />
            <span className="tabular" style={{ fontSize: 9, color: "var(--text-dim)" }}>{k}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LengthScatter({ data }: { data: FactionMonth[] }) {
  const h = 120;
  const margin = { top: 8, right: 8, bottom: 20, left: 8 };
  const ph = h - margin.top - margin.bottom;

  const panels: { label: string; xField: "length" | "battle"; yFn: (d: FactionMonth, f: string) => number | null; yLabel: string }[] = [
    { label: "Zones vs length", xField: "length", yFn: (d, f) => d.zones[f] ?? 0, yLabel: "zones" },
    { label: "Launches/day vs length", xField: "length", yFn: (d, f) => d.length > 0 ? (d.launches[f] ?? 0) / d.length : null, yLabel: "/day" },
    { label: "Kills/battle day vs battle days", xField: "battle", yFn: (d, f) => d.battle > 0 && f in d.kills ? (d.kills[f] ?? 0) / d.battle : null, yLabel: "/day" },
  ];

  return (
    <div style={{ marginBottom: 24 }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>Length vs outcome</div>
      {panels.map(p => {
        const points: { x: number; y: number; faction: string; month: string }[] = [];
        for (const d of data) {
          for (const f of FACTIONS) {
            const y = p.yFn(d, f);
            if (y == null) continue;
            points.push({ x: d[p.xField], y, faction: f, month: d.month });
          }
        }
        if (points.length === 0) return null;
        const maxX = Math.max(...points.map(pt => pt.x));
        const minX = Math.min(...points.map(pt => pt.x));
        const maxY = Math.max(...points.map(pt => pt.y), 1);
        const xRange = Math.max(maxX - minX, 1);
        const pw = 100;
        const sx = (v: number) => margin.left + ((v - minX) / xRange) * (pw - margin.left - margin.right);
        const sy = (v: number) => margin.top + ph - (v / maxY) * ph;

        return (
          <div key={p.label} style={{ marginBottom: 12 }}>
            <div className="eyebrow" style={{ fontSize: 10, marginBottom: 4 }}>{p.label}</div>
            <svg width="100%" height={h} viewBox={`0 0 ${pw} ${h}`} preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
              {points.map((pt, i) => (
                <circle key={i} cx={sx(pt.x)} cy={sy(pt.y)} r={1.5} fill={factionHex(pt.faction)} opacity={0.6}>
                  <title>{pt.month} {pt.faction}: {compact(pt.y)} {p.yLabel} at {pt.x} days</title>
                </circle>
              ))}
              {Array.from(new Set(points.map(pt => pt.x))).map(xv => (
                <text key={xv} x={sx(xv)} y={h - 2} textAnchor="middle" fontSize={4} fill="var(--text-dim)">{xv}</text>
              ))}
            </svg>
          </div>
        );
      })}
    </div>
  );
}

function FactionTable({ factions }: { factions: Record<string, FactionAllTime> }) {
  const list = Object.entries(factions).sort(
    ([, a], [, b]) => b.wins - a.wins || b.qredits - a.qredits,
  );
  return (
    <div style={{ marginBottom: 24 }}>
      <div className="eyebrow" style={{ marginBottom: 4 }}>All-time standings</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
          <thead>
            <tr>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Faction</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Wins</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Launches</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Qredits</th>
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
    </div>
  );
}

export default function Factions({ index }: Props) {
  const tournaments = useMemo(() => mergedTournaments(index), [index]);
  const data = useMemo(() => buildFactionMonths(tournaments), [tournaments]);

  return (
    <div style={section}>
      <div className="display" style={{ fontSize: 13, marginBottom: 12 }}>Factions</div>
      <FactionTable factions={index.all_time.factions} />
      <PlacementCounts tournaments={tournaments} />
      <OverTime data={data} />
      <Distributions data={data} />
      <Streaks data={data} />
      <DayHistograms data={data} />
      <LengthScatter data={data} />
    </div>
  );
}
