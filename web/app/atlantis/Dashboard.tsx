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
  onZoneClick: (key: string) => void;
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

function hasPositiveGain(month: MonthPayload): boolean {
  for (const f of FACTION_ORDER) {
    const fd = month.factions[f];
    if (!fd) continue;
    for (let i = 0; i < fd.launches_gained.length; i++) {
      if ((fd.launches_gained[i] ?? 0) > 0) return true;
    }
  }
  return false;
}

function FactionBars({ month, tournament }: { month: MonthPayload; tournament: TournamentSummary }) {
  const length = tournament.stacking_days + tournament.battle_days;
  const hours = length * 24;
  const pairs = FACTION_ORDER.filter(f => month.players[f]).map(f => {
    let sum = 0;
    for (const p of Object.values(month.players[f] ?? {})) {
      const arr = p.launches;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] != null) { sum += arr[i]!; break; }
      }
    }
    return { f, total: sum };
  }).sort((a, b) => b.total - a.total);
  const factions = pairs.map(p => p.f);
  const totals = pairs.map(p => p.total);
  const max = Math.max(...totals, 1);

  return (
    <div style={section}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>Faction launches</div>
      <div style={{ color: "var(--text-dim)", fontSize: 10, marginBottom: 12 }}>
        Final-board launches over {length} days
      </div>
      {factions.map((f, i) => {
        const rate = hours > 0 ? totals[i] / hours : 0;
        return (
          <div key={f} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ width: 60, fontSize: 11, color: factionColor(f), fontWeight: 600 }}>{f}</span>
            <div style={{ flex: 1, height: 14, background: "var(--hairline)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${(totals[i] / max) * 100}%`, height: "100%", background: factionHex(f), borderRadius: 2 }} />
            </div>
            <span className="tabular" style={{ fontSize: 11, width: 90, textAlign: "right" }}>
              {compact(totals[i])}
            </span>
            <span className="tabular" style={{ fontSize: 10, color: "var(--text-dim)", width: 90, textAlign: "right" }}>
              est. {compact(rate)}/hr
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FactionCharts({ month, tournament }: { month: MonthPayload; tournament: TournamentSummary }) {
  if (!hasPositiveGain(month)) {
    return <FactionBars month={month} tournament={tournament} />;
  }

  const obsTs = parseObsTimestamps(month.observations);

  const launchesSeries: Series[] =
    FACTION_ORDER.filter((f) => month.factions[f]).map((f) => ({
      label: f,
      color: factionHex(f),
      values: month.factions[f].launches_total.map((v) => v ?? null),
    }));

  const rateSeries: Series[] =
    FACTION_ORDER.filter((f) => month.factions[f]).map((f) => ({
      label: f,
      color: factionHex(f),
      values: computePerHourRates(month.factions[f].launches_gained, obsTs),
    }));

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

export default function Dashboard({ month, tournament, onPlayerClick, onZoneClick }: Props) {
  const obsTs = useMemo(() => parseObsTimestamps(month.observations), [month.observations]);

  return (
    <>
      <Placements month={month} tournament={tournament} />
      <hr style={divider} />
      <FactionCharts month={month} tournament={tournament} />
      <hr style={divider} />
      <div style={section}>
        <Leaderboard month={month} obsTimestamps={obsTs} onPlayerClick={onPlayerClick} />
      </div>
      <hr style={divider} />
      <div style={section}>
        <ZoneCards month={month} obsTimestamps={obsTs} onZoneClick={onZoneClick} />
      </div>
    </>
  );
}
