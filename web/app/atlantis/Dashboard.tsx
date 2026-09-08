"use client";

import { useMemo, type CSSProperties } from "react";
import { MultiSeries, type Series } from "@/components/charts/MultiSeries";
import {
  parseObsTimestamps,
  formatObs,
  formatDateTime,
  factionColor,
  factionHex,
  computePerHourRates,
  compact,
  FACTION_ORDER,
  type MonthPayload,
  type TournamentSummary,
} from "./lib";
import Leaderboard from "./Leaderboard";
import ZoneCards from "./ZoneCards";

interface Props {
  month: MonthPayload;
  tournament: TournamentSummary;
  onPlayerClick: (faction: string, name: string) => void;
}

const section: CSSProperties = { padding: "16px 16px 24px" };
const divider: CSSProperties = { borderTop: "1px solid var(--hairline)", margin: 0 };

function factionTotalBots(month: MonthPayload, faction: string): number {
  const key = faction.toLowerCase() as "legion" | "swarm" | "faceless";
  let total = 0;
  for (const zone of Object.values(month.zones)) {
    const arr = zone[key];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] !== null) { total += arr[i]!; break; }
    }
  }
  return total;
}

function Placements({ month, tournament }: { month: MonthPayload; tournament: TournamentSummary }) {
  const label = tournament.is_finished ? "Final" : "If standings held";
  return (
    <div style={section}>
      <div className="eyebrow" style={{ marginBottom: 10 }}>{label}</div>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        {month.placements.map(([faction, zones], i) => (
          <div key={faction} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 20, fontWeight: 700, color: "var(--text-dim)" }}>{i + 1}</span>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: factionColor(faction) }} />
            <span style={{ fontWeight: 600 }}>{faction}</span>
            <span className="tabular" style={{ color: "var(--text-dim)" }}>
              {zones} zones · {compact(factionTotalBots(month, faction))} bots
            </span>
          </div>
        ))}
      </div>
      <div style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 8 }}>
        {tournament.observations} observations, {formatDateTime(tournament.first_observed_at)} to{" "}
        {formatDateTime(tournament.last_observed_at)}
      </div>
    </div>
  );
}

function FactionCharts({ month }: { month: MonthPayload }) {
  const obsTs = useMemo(() => parseObsTimestamps(month.observations), [month.observations]);

  const launchesSeries: Series[] = useMemo(
    () =>
      FACTION_ORDER.filter((f) => month.factions[f]).map((f) => ({
        label: f,
        color: factionHex(f),
        values: month.factions[f].launches_total.map((v) => v ?? null),
      })),
    [month.factions],
  );

  const rateSeries: Series[] = useMemo(
    () =>
      FACTION_ORDER.filter((f) => month.factions[f]).map((f) => ({
        label: f,
        color: factionHex(f),
        values: computePerHourRates(month.factions[f].launches_gained, obsTs),
      })),
    [month.factions, obsTs],
  );

  return (
    <div style={{ ...section, display: "flex", gap: 24, flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 280 }}>
        <MultiSeries x={obsTs} series={launchesSeries} title="Faction launches" labelOf={formatObs} />
      </div>
      <div style={{ flex: 1, minWidth: 280 }}>
        <MultiSeries
          x={obsTs}
          series={rateSeries}
          title="Launches per hour"
          subtitle="normalized by interval length"
          labelOf={formatObs}
          unit="/hr"
        />
      </div>
    </div>
  );
}

export default function Dashboard({ month, tournament, onPlayerClick }: Props) {
  const obsTs = useMemo(() => parseObsTimestamps(month.observations), [month.observations]);

  return (
    <>
      <Placements month={month} tournament={tournament} />
      <hr style={divider} />
      <FactionCharts month={month} />
      <hr style={divider} />
      <div style={section}>
        <Leaderboard month={month} obsTimestamps={obsTs} onPlayerClick={onPlayerClick} />
      </div>
      <hr style={divider} />
      <div style={section}>
        <ZoneCards month={month} obsTimestamps={obsTs} />
      </div>
    </>
  );
}
