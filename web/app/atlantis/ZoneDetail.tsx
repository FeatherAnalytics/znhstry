"use client";

import { useMemo, type CSSProperties } from "react";
import { MultiSeries, type Series } from "@/components/charts/MultiSeries";
import {
  formatObs,
  factionColor,
  factionHex,
  holderOf,
  compact,
  FACTION_ORDER,
  type MonthPayload,
} from "./lib";

interface Props {
  zoneKey: string;
  month: MonthPayload;
  obsTimestamps: number[];
  onClose: () => void;
}

const section: CSSProperties = {
  padding: "16px 16px 24px",
  borderTop: "1px solid var(--hairline)",
  background: "var(--ink-raised)",
};

const cellStyle: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--hairline)",
  whiteSpace: "nowrap",
};

interface Delta {
  index: number;
  prevIndex: number;
  legion: number;
  swarm: number;
  faceless: number;
}

function computeDeltas(
  legion: (number | null)[],
  swarm: (number | null)[],
  faceless: (number | null)[],
): Delta[] {
  const result: Delta[] = [];
  let prev = -1;
  for (let i = 0; i < legion.length; i++) {
    if (legion[i] === null && swarm[i] === null && faceless[i] === null) continue;
    if (prev >= 0) {
      result.push({
        index: i,
        prevIndex: prev,
        legion: (legion[i] ?? 0) - (legion[prev] ?? 0),
        swarm: (swarm[i] ?? 0) - (swarm[prev] ?? 0),
        faceless: (faceless[i] ?? 0) - (faceless[prev] ?? 0),
      });
    }
    prev = i;
  }
  return result;
}

function deltaCell(value: number, faction: string): CSSProperties {
  return {
    ...cellStyle,
    textAlign: "right" as const,
    color: value < 0 ? "var(--legion)" : value > 0 ? factionColor(faction) : "var(--text-dim)",
  };
}

function formatDelta(n: number): string {
  if (n > 0) return `+${compact(n)}`;
  if (n < 0) return `−${compact(Math.abs(n))}`;
  return "0";
}

export default function ZoneDetail({ zoneKey, month, obsTimestamps, onClose }: Props) {
  const data = month.zones[zoneKey];
  if (!data) return null;

  const lastIdx = month.observations.length - 1;
  const holder = holderOf(data, lastIdx);

  const series: Series[] = useMemo(
    () =>
      FACTION_ORDER.map((f) => ({
        label: f,
        color: factionHex(f),
        values: data[f.toLowerCase() as "legion" | "swarm" | "faceless"],
      })),
    [data],
  );

  const deltas = useMemo(
    () => computeDeltas(data.legion, data.swarm, data.faceless),
    [data],
  );

  return (
    <div style={section}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
        <button type="button" onClick={onClose} style={{ color: "var(--text-dim)", cursor: "pointer", background: "none", border: "none", fontSize: 16 }}>✕</button>
        <span className="display" style={{ fontSize: 16 }}>{zoneKey}</span>
        <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{data.name}</span>
        {data.cubes_allowed ? <span style={{ color: "var(--text-dim)", fontSize: 10 }}>cubes</span> : null}
        {holder ? (
          <span style={{ color: factionColor(holder), fontSize: 12 }}>{holder}</span>
        ) : null}
      </div>

      <div className="display" style={{ fontSize: 11, marginBottom: 4 }}>Zone counts</div>
      <MultiSeries x={obsTimestamps} series={series} title="" labelOf={formatObs} />

      {deltas.length > 0 ? (
        <>
          <div className="display" style={{ fontSize: 11, marginBottom: 4, marginTop: 16 }}>Changes per interval</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
              <thead>
                <tr>
                  <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Time</th>
                  <th className="eyebrow" style={{ ...cellStyle, textAlign: "right", color: "var(--legion)" }}>Legion</th>
                  <th className="eyebrow" style={{ ...cellStyle, textAlign: "right", color: "var(--swarm)" }}>Swarm</th>
                  <th className="eyebrow" style={{ ...cellStyle, textAlign: "right", color: "var(--faceless)" }}>Faceless</th>
                </tr>
              </thead>
              <tbody>
                {deltas.map((d) => (
                  <tr key={d.index}>
                    <td className="tabular" style={{ ...cellStyle, color: "var(--text-dim)" }}>{formatObs(obsTimestamps[d.index])}</td>
                    <td className="tabular" style={deltaCell(d.legion, "Legion")}>{formatDelta(d.legion)}</td>
                    <td className="tabular" style={deltaCell(d.swarm, "Swarm")}>{formatDelta(d.swarm)}</td>
                    <td className="tabular" style={deltaCell(d.faceless, "Faceless")}>{formatDelta(d.faceless)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
