"use client";

import { type CSSProperties } from "react";
import { factionColor, compact, type AtlantisIndex } from "./lib";

interface Props {
  index: AtlantisIndex;
}

const cellStyle: CSSProperties = {
  padding: "12px 10px",
  borderBottom: "1px solid var(--hairline)",
  whiteSpace: "nowrap",
};

const section: CSSProperties = { padding: "16px 16px 24px" };

export default function AllTime({ index }: Props) {
  const { players, factions } = index.all_time;

  const factionList = Object.entries(factions)
    .sort(([, a], [, b]) => b.qredits - a.qredits);

  return (
    <div style={section}>
      <div className="display" style={{ fontSize: 13, marginBottom: 4 }}>All time standings</div>
      <div style={{ color: "var(--text-dim)", fontSize: 11, marginBottom: 16 }}>Finished tournaments only</div>

      <div className="display" style={{ fontSize: 12, marginBottom: 8 }}>Factions</div>
      <div style={{ overflowX: "auto", marginBottom: 24 }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
          <thead>
            <tr>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Faction</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Wins</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Qredits</th>
            </tr>
          </thead>
          <tbody>
            {factionList.map(([faction, data]) => (
              <tr key={faction}>
                <td style={{ ...cellStyle, color: factionColor(faction), fontWeight: 600 }}>{faction}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{data.wins}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{compact(data.qredits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="display" style={{ fontSize: 12, marginBottom: 8 }}>Players</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
          <thead>
            <tr>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Player</th>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Faction</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Launches</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Appearances</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Qredits</th>
            </tr>
          </thead>
          <tbody>
            {players.map(([name, faction, launches, appearances, qredits]) => (
              <tr key={`${faction}:${name}`}>
                <td style={cellStyle}>{name}</td>
                <td style={cellStyle}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: factionColor(faction) }} />
                    {faction}
                  </span>
                </td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{launches.toLocaleString()}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{appearances}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{compact(qredits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
