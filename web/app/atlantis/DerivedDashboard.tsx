"use client";

import { type CSSProperties } from "react";
import {
  factionColor,
  formatDate,
  compact,
  FACTION_ORDER,
  type DerivedMonthPayload,
  type DerivedTournamentSummary,
} from "./lib";

interface Props {
  month: DerivedMonthPayload;
  tournament: DerivedTournamentSummary;
}

const section: CSSProperties = { padding: "16px 16px 24px" };
const divider: CSSProperties = { borderTop: "1px solid var(--hairline)", margin: 0 };

const cellStyle: CSSProperties = {
  padding: "12px 10px",
  borderBottom: "1px solid var(--hairline)",
  whiteSpace: "nowrap",
};

const TRIANGLE_ORDER = ["Central", "Legion", "Swarm", "Faceless"];

function Placements({ month, tournament }: Props) {
  const tieNote =
    tournament.placement_tiebreak === "bots" ? " (decided by total bots)"
    : tournament.placement_tiebreak === "prime" ? " (decided by Prime)"
    : "";

  return (
    <div style={section}>
      <div className="eyebrow" style={{ marginBottom: 10 }}>Final, derived from battle reports</div>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        {month.placements.map(([faction, zones, pool], i) => (
          <div key={faction} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 20, fontWeight: 700, color: "var(--text-dim)" }}>{i + 1}</span>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: factionColor(faction) }} />
            <span style={{ fontWeight: 600 }}>{faction}</span>
            <span className="tabular" style={{ color: "var(--text-dim)" }}>
              {zones} zones · {compact(pool)} qredits
            </span>
            {i > 0 && tieNote ? (
              <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{tieNote}</span>
            ) : null}
          </div>
        ))}
      </div>
      <div style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 8 }}>
        {tournament.reports} reports, {formatDate(tournament.first_report_date)} to{" "}
        {formatDate(tournament.last_report_date)}
      </div>
    </div>
  );
}

function ZonesTable({ month }: { month: DerivedMonthPayload }) {
  const sorted = [...month.zones].sort((a, b) => {
    const ta = TRIANGLE_ORDER.indexOf(a.triangle);
    const tb = TRIANGLE_ORDER.indexOf(b.triangle);
    if (ta !== tb) return ta - tb;
    if (a.position !== null && b.position !== null) return a.position - b.position;
    if (a.position !== null) return -1;
    if (b.position !== null) return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div>
      <div className="display" style={{ fontSize: 13, marginBottom: 12 }}>Zones</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
          <thead>
            <tr>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Triangle</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Pos</th>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Name</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right", color: "var(--legion)" }}>Legion</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right", color: "var(--swarm)" }}>Swarm</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right", color: "var(--faceless)" }}>Faceless</th>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Holder</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((z, i) => (
              <tr key={`${z.triangle}:${z.name}:${i}`}>
                <td style={{ ...cellStyle, color: factionColor(z.triangle === "Central" ? "" : z.triangle) }}>
                  {z.triangle}
                </td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>
                  {z.position ?? "—"}
                </td>
                <td style={cellStyle}>{z.name}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{compact(z.legion)}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{compact(z.swarm)}</td>
                <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{compact(z.faceless)}</td>
                <td style={{ ...cellStyle, color: z.holder ? factionColor(z.holder) : "var(--text-dim)" }}>
                  {z.holder ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlayersTable({ month }: { month: DerivedMonthPayload }) {
  const factionOrder = [...FACTION_ORDER, "Unconfirmed"];
  const hasAnyPlayers = factionOrder.some((f) => month.players[f] && Object.keys(month.players[f]).length > 0);

  if (!hasAnyPlayers) {
    return (
      <div>
        <div className="display" style={{ fontSize: 13, marginBottom: 12 }}>Players</div>
        <div style={{ color: "var(--text-dim)", fontSize: 12 }}>Not yet attributed</div>
      </div>
    );
  }

  return (
    <div>
      <div className="display" style={{ fontSize: 13, marginBottom: 12 }}>Players</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
          <thead>
            <tr>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Player</th>
              <th className="eyebrow" style={{ ...cellStyle, textAlign: "left" }}>Faction</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Launches</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Kills</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Lost</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Reports</th>
              <th className="eyebrow tabular" style={{ ...cellStyle, textAlign: "right" }}>Qredits (est.)</th>
            </tr>
          </thead>
          <tbody>
            {factionOrder.flatMap((faction) => {
              const players = month.players[faction];
              if (!players || Object.keys(players).length === 0) return [];

              const sorted = Object.entries(players).sort(
                ([na, a], [nb, b]) => b.launches - a.launches || na.localeCompare(nb),
              );

              const rows: React.ReactNode[] = [];
              if (faction === "Unconfirmed") {
                rows.push(
                  <tr key="unconfirmed-caveat">
                    <td colSpan={7} style={{ ...cellStyle, color: "var(--text-dim)", fontSize: 11 }}>
                      Faction could not be established from the reports.
                    </td>
                  </tr>,
                );
              }
              for (const [name, p] of sorted) {
                rows.push(
                  <tr key={`${faction}:${name}`}>
                    <td style={cellStyle}>
                      {name}
                      {p.is_mercenary ? <span style={{ color: "var(--text-dim)", marginLeft: 4, fontSize: 10 }} title="Mercenary">M</span> : null}
                    </td>
                    <td style={cellStyle}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: factionColor(faction) }} />
                        {faction}
                      </span>
                    </td>
                    <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{p.launches.toLocaleString()}</td>
                    <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{p.bots_killed.toLocaleString()}</td>
                    <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{p.bots_lost.toLocaleString()}</td>
                    <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>{p.reports}</td>
                    <td className="tabular" style={{ ...cellStyle, textAlign: "right" }}>
                      {p.qredits_estimate !== null ? compact(p.qredits_estimate) : "—"}
                    </td>
                  </tr>,
                );
              }
              return rows;
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function DerivedDashboard({ month, tournament }: Props) {
  return (
    <>
      <Placements month={month} tournament={tournament} />
      <hr style={divider} />
      <div style={section}>
        <ZonesTable month={month} />
      </div>
      <hr style={divider} />
      <div style={section}>
        <PlayersTable month={month} />
      </div>
    </>
  );
}
