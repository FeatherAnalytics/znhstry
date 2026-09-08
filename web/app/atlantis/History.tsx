"use client";

import { type CSSProperties } from "react";
import { factionColor, formatDateTime, type AtlantisIndex } from "./lib";

interface Props {
  index: AtlantisIndex;
  onMonthClick: (month: string) => void;
}

const cellStyle: CSSProperties = {
  padding: "12px 10px",
  borderBottom: "1px solid var(--hairline)",
  whiteSpace: "nowrap",
};

const section: CSSProperties = { padding: "16px 16px 24px" };

export default function History({ index, onMonthClick }: Props) {
  const tournaments = [...index.tournaments].reverse();

  return (
    <div style={section}>
      <div className="display" style={{ fontSize: 13, marginBottom: 12 }}>Tournament history</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
          <thead>
            <tr>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Month</th>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Winner</th>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>1st</th>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>2nd</th>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>3rd</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Players</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Obs</th>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Coverage</th>
            </tr>
          </thead>
          <tbody>
            {tournaments.map((t) => (
              <tr
                key={t.month}
                onClick={() => onMonthClick(t.month)}
                style={{ cursor: "pointer" }}
              >
                <td style={{ ...cellStyle, fontWeight: 600 }}>{t.month}</td>
                <td style={cellStyle}>
                  {t.winner ? (
                    <span style={{ color: factionColor(t.winner) }}>{t.winner}</span>
                  ) : (
                    <span style={{ color: "var(--text-dim)" }}>In progress</span>
                  )}
                </td>
                <td style={cellStyle}>
                  {t.placements[0] ? <span style={{ color: factionColor(t.placements[0][0]) }}>{t.placements[0][0]}</span> : "—"}
                </td>
                <td style={cellStyle}>
                  {t.placements[1] ? <span style={{ color: factionColor(t.placements[1][0]) }}>{t.placements[1][0]}</span> : "—"}
                </td>
                <td style={cellStyle}>
                  {t.placements[2] ? <span style={{ color: factionColor(t.placements[2][0]) }}>{t.placements[2][0]}</span> : "—"}
                </td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{t.players.toLocaleString()}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{t.observations}</td>
                <td style={{ ...cellStyle, color: "var(--text-dim)", fontSize: 11 }}>
                  {formatDateTime(t.first_observed_at)} to {formatDateTime(t.last_observed_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
