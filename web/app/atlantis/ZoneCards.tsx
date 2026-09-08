"use client";

import { type CSSProperties } from "react";
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
  minWidth: 140,
  flex: "1 1 140px",
};

const ROWS: [string | null, string[]][] = [
  [null, ["Prime"]],
  ["Legion", ["Legion 1", "Legion 2", "Legion 3", "Legion 4", "Legion 5", "Legion 6"]],
  ["Swarm", ["Swarm 1", "Swarm 2", "Swarm 3", "Swarm 4", "Swarm 5", "Swarm 6"]],
  ["Faceless", ["Faceless 1", "Faceless 2", "Faceless 3", "Faceless 4", "Faceless 5", "Faceless 6"]],
];

function ZoneCard({ zoneKey, month, lastIdx }: { zoneKey: string; month: MonthPayload; lastIdx: number }) {
  const data = month.zones[zoneKey];
  if (!data) return null;
  const holder = holderOf(data, lastIdx);
  return (
    <div style={card}>
      <div className="eyebrow" style={{ marginBottom: 4 }}>{zoneKey}</div>
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6 }}>
        {data.name}
        {data.cubes_allowed ? (
          <span style={{ marginLeft: 6, fontSize: 10 }}>cubes</span>
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
}

export default function ZoneCards({ month }: Props) {
  const lastIdx = month.observations.length - 1;

  return (
    <div>
      <div className="display" style={{ fontSize: 13, marginBottom: 12 }}>Zones</div>
      {ROWS.map(([faction, keys]) => (
        <div key={faction ?? "prime"} style={{ marginBottom: 10 }}>
          {faction ? (
            <div className="eyebrow" style={{ marginBottom: 6, color: factionColor(faction) }}>{faction}</div>
          ) : null}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {keys.map((k) => (
              <ZoneCard key={k} zoneKey={k} month={month} lastIdx={lastIdx} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
