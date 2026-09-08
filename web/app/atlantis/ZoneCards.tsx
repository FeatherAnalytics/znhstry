"use client";

import { useMemo, type CSSProperties } from "react";
import { factionColor, holderOf, compact, type MonthPayload } from "./lib";

interface Props {
  month: MonthPayload;
  obsTimestamps: number[];
}

const card: CSSProperties = {
  background: "var(--ink-raised)",
  border: "1px solid var(--hairline)",
  borderRadius: 4,
  padding: "10px 12px",
};

export default function ZoneCards({ month }: Props) {
  const lastIdx = month.observations.length - 1;

  const zones = useMemo(
    () => Object.entries(month.zones).map(([key, data]) => ({ key, data })),
    [month.zones],
  );

  return (
    <div>
      <div className="display" style={{ fontSize: 13, marginBottom: 12 }}>Zones</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
        {zones.map(({ key, data }) => {
          const holder = holderOf(data, lastIdx);
          return (
            <div key={key} style={card}>
              <div className="eyebrow" style={{ marginBottom: 4 }}>{key}</div>
              <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6 }}>
                {data.name}
                {data.cubes_allowed ? (
                  <span style={{ marginLeft: 6, color: "var(--text-dim)", fontSize: 10 }}>cubes</span>
                ) : null}
              </div>
              <div className="tabular" style={{ display: "flex", gap: 8, fontSize: 11 }}>
                <span style={{ color: "var(--legion)" }}>L {compact(data.legion[lastIdx] ?? 0)}</span>
                <span style={{ color: "var(--swarm)" }}>S {compact(data.swarm[lastIdx] ?? 0)}</span>
                <span style={{ color: "var(--faceless)" }}>F {compact(data.faceless[lastIdx] ?? 0)}</span>
              </div>
              {holder ? (
                <div style={{ fontSize: 11, marginTop: 4, color: factionColor(holder) }}>{holder}</div>
              ) : (
                <div style={{ fontSize: 11, marginTop: 4, color: "var(--text-dim)" }}>Empty</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
