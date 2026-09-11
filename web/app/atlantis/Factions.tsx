"use client";

import { useMemo, useState, useRef, type CSSProperties } from "react";
import { useChartHover, useBarHover } from "./useChartHover";
import { useWidth, YearLabels } from "./chartUtils";
import { FACTIONS as FACTION_DEFS, PLACEMENT_GOLD, PLACEMENT_SILVER, PLACEMENT_BRONZE } from "@/components/charts/palette";
import {
  factionColor,
  factionHex,
  compact,
  mergedTournaments,
  type AtlantisIndex,
  type AnyTournament,
  type AllTimePlayer,
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
const readoutStyle: CSSProperties = { fontSize: 10, color: "var(--text-dim)", marginTop: 2, minHeight: 16 };
const FACTION_NAMES = FACTION_DEFS.map(f => f.label);
const PLACEMENTS = [PLACEMENT_GOLD, PLACEMENT_SILVER, PLACEMENT_BRONZE];
const PLACE_LABELS = ["1st", "2nd", "3rd"];

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


interface LineChartProps {
  data: FM[];
  getVal: (d: FM, f: string, i: number) => number | null;
  label: string;
  height: number;
  halfMark?: boolean;
  crossings?: Record<string, number>;
}

function buildSegments(data: FM[], getVal: (d: FM, f: string, i: number) => number | null, f: string, step: number, ph: number, maxV: number) {
  const segments: string[] = [];
  const singles: { x: number; y: number }[] = [];
  let cur = "";
  let curCount = 0;
  let curStart = 0;
  for (let i = 0; i < data.length; i++) {
    const v = getVal(data[i], f, i);
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
  return { segments, singles };
}

function findCrossing(data: FM[], getVal: (d: FM, f: string, i: number) => number | null, f: string, halfV: number, crossings?: Record<string, number>): number {
  const preset = crossings?.[f] ?? -1;
  if (preset >= 0) return preset;
  let prev: number | null = null;
  for (let i = 0; i < data.length; i++) {
    const v = getVal(data[i], f, i);
    if (v != null && v >= halfV && (prev == null || prev < halfV)) return i;
    if (v != null) prev = v;
  }
  return -1;
}

function HalfMarkOverlay(props: LineChartProps & { w: number; ph: number; maxV: number; step: number }) {
  const halfV = props.maxV / 2;
  const halfYPos = 4 + props.ph - (halfV / props.maxV) * props.ph;
  return (
    <>
      <line x1={0} x2={props.w} y1={halfYPos} y2={halfYPos} stroke="var(--hairline)" strokeWidth={1} strokeDasharray="3,3" />
      {FACTIONS.map(f => {
        const crossIdx = findCrossing(props.data, props.getVal, f, halfV, props.crossings);
        if (crossIdx < 0) return null;
        const x = crossIdx * props.step;
        return (
          <g key={`half:${f}`}>
            <line x1={x} x2={x} y1={halfYPos} y2={4 + props.ph} stroke={factionHex(f)} strokeWidth={0.5} opacity={0.5} />
            <circle cx={x} cy={halfYPos} r={2.5} fill={factionHex(f)} opacity={0.8} />
          </g>
        );
      })}
    </>
  );
}

function LineChart(props: LineChartProps) {
  const { data, getVal, label, height, halfMark, crossings } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const w = useWidth(containerRef);
  const maxV = Math.max(...FACTIONS.flatMap(f => data.map((d, i) => getVal(d, f, i) ?? 0)), 1);
  const n = data.length;
  const step = w / Math.max(n - 1, 1);
  const { hover, onPointerMove, onPointerLeave } = useChartHover(n, step);
  const ph = height - 18;

  return (
    <div style={{ marginBottom: 12 }} ref={containerRef}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 4 }}>{label}</div>
      <div style={{ position: "relative" }}>
        <span className="tabular" style={{ position: "absolute", top: 0, left: 0, fontSize: 8, color: "var(--text-dim)" }}>{compact(maxV)}</span>
        <svg width={w} height={height} style={{ display: "block" }} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>
          {FACTIONS.map(f => {
            const { segments, singles } = buildSegments(data, getVal, f, step, ph, maxV);
            return [
              ...segments.map((seg, si) => (
                <polyline key={`${f}:${si}`} points={seg} fill="none" stroke={factionHex(f)} strokeWidth={1.5} opacity={0.8} />
              )),
              ...singles.map((pt, pi) => (
                <circle key={`${f}:dot:${pi}`} cx={pt.x} cy={pt.y} r={2} fill={factionHex(f)} opacity={0.8} />
              )),
            ];
          })}
          {halfMark ? <HalfMarkOverlay {...props} w={w} ph={ph} maxV={maxV} step={step} /> : null}
          {hover ? (
            <>
              <line x1={hover.x} x2={hover.x} y1={0} y2={height} stroke="var(--text-dim)" strokeWidth={1} opacity={0.3} />
              {FACTIONS.map(f => {
                const v = getVal(data[hover.index], f, hover.index);
                if (v == null) return null;
                const y = 4 + ph - (v / maxV) * ph;
                return <circle key={f} cx={hover.x} cy={y} r={3} fill={factionHex(f)} />;
              })}
            </>
          ) : null}
        </svg>
      </div>
      <YearLabels months={data.map(d => d.month)} />
      <div style={readoutStyle}>
        {hover ? (
          <>
            <span style={{ fontWeight: 600 }}>{data[hover.index].month}</span>
            {FACTIONS.map(f => {
              const v = getVal(data[hover.index], f, hover.index);
              return v != null ? <span key={f} style={{ marginLeft: 8, color: factionHex(f) }}>{compact(v)}</span> : null;
            })}
          </>
        ) : null}
      </div>
    </div>
  );
}

type CumKey = "launches" | "kills" | "factionPlayers";
const FM_SOURCES: Record<CumKey, (d: FM) => Record<string, number>> = {
  launches: d => d.launches,
  kills: d => d.kills,
  factionPlayers: d => d.factionPlayers,
};

function cumAccum(data: FM[], key: CumKey): Record<string, number | null>[] {
  const acc: Record<string, number> = {};
  const seen: Record<string, boolean> = {};
  const getSrc = FM_SOURCES[key];
  return data.map(d => {
    const row: Record<string, number | null> = {};
    const src = getSrc(d);
    for (const f of FACTIONS) {
      if (f in src) { acc[f] = (acc[f] ?? 0) + (src[f] ?? 0); seen[f] = true; }
      row[f] = seen[f] ? (acc[f] ?? 0) : null;
    }
    return row;
  });
}

function launchValAt(cumLaunches: Record<string, number | null>[], mode: Mode, i: number, d: FM, f: string): number | null {
  if (mode === "cumulative") return cumLaunches[i]?.[f] ?? 0;
  const v = d.launches[f] ?? 0;
  return mode === "perday" && d.length > 0 ? v / d.length : v;
}

function killValAt(cumKills: Record<string, number | null>[], mode: Mode, i: number, d: FM, f: string): number | null {
  if (mode === "cumulative") return cumKills[i]?.[f] ?? null;
  if (!(f in d.kills)) return null;
  const v = d.kills[f] ?? 0;
  if (mode !== "perday") return v;
  return d.battle > 0 ? v / d.battle : null;
}

function playerValAt(cumPlayers: Record<string, number | null>[], mode: Mode, i: number, d: FM, f: string): number | null {
  if (mode === "cumulative") return cumPlayers[i]?.[f] ?? null;
  const v = d.factionPlayers[f];
  if (v == null) return null;
  return mode === "perday" && d.length > 0 ? v / d.length : v;
}

function OverTime({ data, mode }: { data: FM[]; mode: Mode }) {
  const cumLaunches = useMemo(() => cumAccum(data, "launches"), [data]);
  const cumKills = useMemo(() => cumAccum(data, "kills"), [data]);

  const cumQredits = useMemo(() => {
    const acc: Record<string, number> = {};
    return data.map(d => {
      const row: Record<string, number> = {};
      for (const f of FACTIONS) { acc[f] = (acc[f] ?? 0) + (d.qredits[f] ?? 0); row[f] = acc[f]; }
      return row;
    });
  }, [data]);

  const qrCrossings = useMemo(() => {
    const maxQr = Math.max(...FACTIONS.flatMap(f => cumQredits.map(r => r[f] ?? 0)), 1);
    const halfQr = maxQr / 2;
    const result: Record<string, number> = {};
    for (const f of FACTIONS) {
      for (let i = 0; i < cumQredits.length; i++) {
        if ((cumQredits[i][f] ?? 0) >= halfQr) { result[f] = i; break; }
      }
    }
    return result;
  }, [cumQredits]);

  const cumPlayers = useMemo(() => cumAccum(data, "factionPlayers"), [data]);

  return (
    <div style={{ marginBottom: 24 }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>Over time</div>
      <LineChart data={data} label={mode === "perday" ? "Launches /day" : "Launches"} height={320} halfMark={mode === "cumulative"} getVal={(d, f, i) => launchValAt(cumLaunches, mode, i, d, f)} />
      <LineChart data={data} label={mode === "perday" ? "Kills /battle day" : "Kills"} height={320} halfMark={mode === "cumulative"} getVal={(d, f, i) => killValAt(cumKills, mode, i, d, f)} />
      {data.some(d => Object.keys(d.factionPlayers).length > 0) ? (
        <LineChart data={data} label={mode === "perday" ? "Players /day" : "Players"} height={320} halfMark={mode === "cumulative"} getVal={(d, f, i) => playerValAt(cumPlayers, mode, i, d, f)} />
      ) : null}
      <LineChart data={data} label="Qredits (cumulative)" height={320} halfMark crossings={qrCrossings} getVal={(_d, f, i) => {
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
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 158 }}>
        {keys.map(k => (
          <div key={k} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "1 1 0" }}>
            <div style={{ width: "100%", maxWidth: 24, height: ((counts[k] ?? 0) / max) * 140, background: "var(--text-dim)", borderRadius: 1 }} title={`${k}: ${counts[k] ?? 0}`} />
            <span className="tabular" style={{ fontSize: 9, color: "var(--text-dim)" }}>{k}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface BucketEntry { faction: string; value: number }

function resolveValue(d: FM, f: string, field: "zones" | "kills", perDay: boolean): number | undefined {
  if (field === "kills" && !(f in d.kills)) return undefined;
  let v = (field === "zones" ? d.zones : d.kills)[f] ?? 0;
  if (!perDay) return v;
  if (field !== "kills") return v;
  return d.battle > 0 ? v / d.battle : undefined;
}

function bucketEntries(data: FM[], field: "zones" | "kills", perDay: boolean): BucketEntry[] {
  const entries: BucketEntry[] = [];
  for (const d of data) {
    for (const f of FACTIONS) {
      const v = resolveValue(d, f, field, perDay);
      if (v != null) entries.push({ faction: f, value: v });
    }
  }
  return entries;
}

function bucketize(entries: BucketEntry[], isZones: boolean, bins: number) {
  const maxZone = 19;
  const bucketCount = isZones ? maxZone + 1 : bins;
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
  return { buckets, bucketCount, min, step };
}

function FactionHistogram({ data, field, label, perDay, bins }: { data: FM[]; field: "zones" | "kills"; label: string; perDay: boolean; bins?: number }) {
  const isZones = field === "zones";
  const entries = bucketEntries(data, field, perDay);
  const { buckets, bucketCount, min, step } = entries.length > 0 ? bucketize(entries, isZones, bins ?? 10) : { buckets: {}, bucketCount: 0, min: 0, step: 1 };
  const { index: hoverIdx, ref: barRef, onPointerMove, onPointerLeave } = useBarHover(bucketCount);

  if (entries.length === 0) return null;
  const maxStack = Math.max(...Array.from({ length: bucketCount }, (_, i) => FACTIONS.reduce((s, f) => s + (buckets[f]?.[i] ?? 0), 0)), 1);

  return (
    <div style={{ flex: 1, minWidth: 180 }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 4 }}>{label}</div>
      <div ref={barRef} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}
        style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 280 }}>
        {Array.from({ length: bucketCount }, (_, i) => (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", width: "100%", opacity: hoverIdx != null && hoverIdx !== i ? 0.4 : 1 }}>
            {FACTIONS.map(f => {
              const c = buckets[f][i];
              return c > 0 ? <div key={f} style={{ width: "100%", height: (c / maxStack) * 260, background: factionHex(f), opacity: 0.7 }} /> : null;
            })}
          </div>
        ))}
      </div>
      {isZones ? (
        <div style={{ display: "flex", gap: 1 }}>
          {Array.from({ length: bucketCount }, (_, i) => (
            <div key={i} style={{ flex: 1, textAlign: "center" }}>
              {i % 2 === 0 ? <span className="tabular" style={{ fontSize: 7, color: "var(--text-dim)" }}>{i}</span> : null}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", position: "relative" }}>
          {Array.from({ length: bucketCount + 1 }, (_, i) => (
            <span key={i} className="tabular" style={{ position: "absolute", left: `${(i / bucketCount) * 100}%`, transform: "translateX(-50%)", fontSize: 7, color: "var(--text-dim)" }}>{compact(min + i * step)}</span>
          ))}
          <div style={{ height: 12 }} />
        </div>
      )}
      <div style={readoutStyle}>
        {hoverIdx != null ? (
          <>
            <span style={{ fontWeight: 600 }}>{isZones ? hoverIdx : `${compact(min + hoverIdx * step)}–${compact(min + (hoverIdx + 1) * step)}`}</span>
            {FACTIONS.map(f => {
              const c = buckets[f][hoverIdx];
              return c > 0 ? <span key={f} style={{ marginLeft: 8, color: factionHex(f) }}>{c}</span> : null;
            })}
          </>
        ) : null}
      </div>
    </div>
  );
}

function groupMeans(data: FM[], xField: "length" | "battle", yFn: (d: FM, f: string) => number | null) {
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
  return { xVals, means, ns, maxMean };
}

interface GroupedBarsProps {
  data: FM[];
  xField: "length" | "battle";
  yFn: (d: FM, f: string) => number | null;
  label: string;
  xLabel: string;
}

function GroupedBars({ data, xField, yFn, label, xLabel }: GroupedBarsProps) {
  const { xVals, means, ns, maxMean } = groupMeans(data, xField, yFn);
  const { index: hoverIdx, ref: barRef, onPointerMove, onPointerLeave } = useBarHover(xVals.length);
  if (xVals.length === 0) return null;

  return (
    <div style={{ flex: "1 1 320px", minWidth: 320 }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 4 }}>{label}</div>
      <div ref={barRef} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave} style={{ display: "flex", height: 160 }}>
        {xVals.map((x, xi) => (
          <div key={x} style={{ flex: "1 1 0", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", opacity: hoverIdx != null && hoverIdx !== xi ? 0.4 : 1 }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 112 }}>
              {FACTIONS.map(f => {
                const m = means[x][f];
                return m != null ? (
                  <div key={f} style={{ width: 12, height: (m / maxMean) * 104, background: factionHex(f), borderRadius: 1 }} />
                ) : null;
              })}
            </div>
            <span className="tabular" style={{ fontSize: 9, color: "var(--text-dim)" }}>{x}</span>
            <span className="tabular" style={{ fontSize: 7, color: "var(--text-dim)" }}>n={ns[x]}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 9, color: "var(--text-dim)", marginTop: 4, textAlign: "center" }}>{xLabel}</div>
      <div style={readoutStyle}>
        {hoverIdx != null ? (
          <>
            <span style={{ fontWeight: 600 }}>{xVals[hoverIdx]} days</span>
            <span style={{ marginLeft: 6 }}>n={ns[xVals[hoverIdx]]}</span>
            {FACTIONS.map(f => {
              const m = means[xVals[hoverIdx]][f];
              return m != null ? <span key={f} style={{ marginLeft: 8, color: factionHex(f) }}>{compact(m)}</span> : null;
            })}
          </>
        ) : null}
      </div>
    </div>
  );
}

function placementRecord(tournaments: AnyTournament[]) {
  const counts: Record<string, [number, number, number]> = {};
  const poolQredits: Record<string, number> = {};
  for (const f of FACTION_NAMES) { counts[f] = [0, 0, 0]; poolQredits[f] = 0; }
  for (const t of tournaments) {
    for (let i = 0; i < 3; i++) {
      const p = t.placements[i];
      if (p && counts[p[0]]) counts[p[0]][i]++;
    }
    for (const p of t.placements) poolQredits[p[0]] = (poolQredits[p[0]] ?? 0) + p[2];
  }
  return { counts, poolQredits };
}

function StandingsTable({ factions, tournaments }: { factions: Record<string, FactionAllTime>; tournaments: AnyTournament[] }) {
  const { counts, poolQredits } = placementRecord(tournaments);
  const total = Math.max(tournaments.length, 1);

  return (
    <div style={{ flex: 1, minWidth: 240 }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left", verticalAlign: "bottom" }} rowSpan={2}>Standings</th>
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "center" }} colSpan={3}>Place</th>
            <th style={cellStyle} rowSpan={2} />
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "center" }} colSpan={2}>Totals</th>
          </tr>
          <tr>
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>1st</th>
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>2nd</th>
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>3rd</th>
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Launches</th>
            <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Qredits</th>
          </tr>
        </thead>
        <tbody>
          {FACTION_NAMES.map(f => (
            <tr key={f}>
              <td style={{ ...cellStyle, color: factionColor(f), fontWeight: 600 }}>{f}</td>
              {counts[f].map((c, i) => <td key={i} className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{c}</td>)}
              <td style={cellStyle}>
                <span style={{ display: "inline-flex", gap: 3 }}>
                  {counts[f].map((c, i) => (
                    <span key={i} style={{ width: Math.max(2, (c / total) * 50), height: 8, background: PLACEMENTS[i], borderRadius: 1 }} title={`${PLACE_LABELS[i]}: ${c}`} />
                  ))}
                </span>
              </td>
              <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{compact(factions[f]?.launches ?? 0)}</td>
              <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{compact(poolQredits[f] ?? 0)}</td>
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
    for (const p of PLACE_LABELS) streaks[f][p] = { current: 0, longest: 0 };
  }
  for (const place of [0, 1, 2]) {
    const label = PLACE_LABELS[place];
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
      <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "left", verticalAlign: "bottom" }} rowSpan={2}>Streaks</th>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "center" }} colSpan={3}>Current</th>
            <th className="eyebrow" style={{ ...cellStyle, textAlign: "center", borderLeft: "1px solid var(--hairline)" }} colSpan={3}>Best</th>
          </tr>
          <tr>
            {PLACE_LABELS.map(p => (
              <th key={`c${p}`} className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>{p}</th>
            ))}
            {PLACE_LABELS.map(p => (
              <th key={`b${p}`} className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right", ...(p === "1st" ? { borderLeft: "1px solid var(--hairline)" } : {}) }}>{p}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FACTIONS.map(f => (
            <tr key={f}>
              <td style={{ ...cellStyle, color: factionColor(f), fontWeight: 600 }}>{f}</td>
              {PLACE_LABELS.map(p => <td key={`c${p}`} className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{streaks[f][p].current}</td>)}
              {PLACE_LABELS.map(p => <td key={`l${p}`} className="tabular" style={{ ...cellStyle, textAlign: "right", ...(p === "1st" ? { borderLeft: "1px solid var(--hairline)" } : {}) }}>{streaks[f][p].longest}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface SeenBarProps {
  counts: Record<string, number>;
  label: string;
  allMonths: string[];
  maxY: number;
  data: FM[];
}

function SeenBar({ counts, label, allMonths, maxY, data }: SeenBarProps) {
  const h = 160;
  const { index: hoverIdx, ref: barRef, onPointerMove, onPointerLeave } = useBarHover(allMonths.length);
  return (
    <div style={{ flex: 1, minWidth: 200 }}>
      <div className="eyebrow" style={{ fontSize: 10, marginBottom: 4 }}>{label}</div>
      <div ref={barRef} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}
        style={{ display: "flex", alignItems: "flex-end", gap: 1, height: h }}>
        {allMonths.map((m, i) => {
          const c = counts[m] ?? 0;
          return (
            <div key={m} style={{
              flex: "1 1 0", minWidth: 0, height: c > 0 ? (c / maxY) * (h - 14) : 0,
              background: "var(--text-dim)", opacity: hoverIdx === i ? 0.9 : 0.7, borderRadius: 1,
              marginLeft: m.endsWith("-01") ? 6 : 0,
            }} />
          );
        })}
      </div>
      <YearLabels months={data.map(d => d.month)} />
      <div style={readoutStyle}>
        {hoverIdx != null ? (
          <><span style={{ fontWeight: 600 }}>{allMonths[hoverIdx]}</span>: {(counts[allMonths[hoverIdx]] ?? 0).toLocaleString("en-US")}</>
        ) : null}
      </div>
    </div>
  );
}

function FirstLastSeen({ players, data }: { players: AllTimePlayer[]; data: FM[] }) {
  const allMonths = data.map(d => d.month);
  const firstCounts: Record<string, number> = {};
  const lastCounts: Record<string, number> = {};
  for (const p of players) {
    firstCounts[p.first_month] = (firstCounts[p.first_month] ?? 0) + 1;
    lastCounts[p.last_month] = (lastCounts[p.last_month] ?? 0) + 1;
  }
  const maxY = Math.max(
    ...allMonths.map(m => firstCounts[m] ?? 0),
    ...allMonths.map(m => lastCounts[m] ?? 0),
    1,
  );
  return (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 24 }}>
      <SeenBar counts={firstCounts} label="First seen" allMonths={allMonths} maxY={maxY} data={data} />
      <SeenBar counts={lastCounts} label="Last seen" allMonths={allMonths} maxY={maxY} data={data} />
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

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24, alignItems: "flex-start", overflowX: "auto" }}>
        <div style={{ flex: "0 0 auto" }}><StandingsTable factions={index.all_time.factions} tournaments={tournaments} /></div>
        <div style={{ flex: "0 0 auto" }}><StreaksTable data={data} /></div>
        <div style={{ flex: "1 1 0", minWidth: 120 }}><Histogram values={data.map(d => d.stacking)} label="Stacking days" rangeMin={0} /></div>
        <div style={{ flex: "1 1 0", minWidth: 120 }}><Histogram values={data.map(d => d.battle)} label="Battle days" rangeMin={1} /></div>
      </div>

      <OverTime data={data} mode={mode} />
      <FirstLastSeen players={index.all_time.players} data={data} />

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 24 }}>
        <FactionHistogram data={data} field="zones" label="Zones held" perDay={false} />
        <FactionHistogram data={data} field="kills" label={perDay ? "Kills /battle day" : "Kills"} perDay={perDay} bins={5} />
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
