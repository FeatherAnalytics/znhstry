"use client";

import { useEffect, useMemo, useState, useCallback, type CSSProperties } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { SiteNav } from "@/components/SiteNav";
import { BASE } from "@/lib/dataOrigin";
import {
  fetchIndex,
  fetchMonth,
  fetchDerivedMonth,
  mergedTournaments,
  isDerived,
  parseObsTimestamps,
  formatDate,
  type AtlantisIndex,
  type MonthPayload,
  type DerivedMonthPayload,
  type DerivedTournamentSummary,
  type AnyTournament,
} from "./lib";
import Dashboard, { type TournamentView } from "./Dashboard";
import DerivedDashboard from "./DerivedDashboard";
import PlayerDetail from "./PlayerDetail";
import ZoneDetail from "./ZoneDetail";
import History from "./History";
import AllTime from "./AllTime";
import Factions from "./Factions";

const panel: CSSProperties = {
  borderBottom: "1px solid var(--hairline)",
  padding: "12px 16px",
};

const btnStyle: CSSProperties = {
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "var(--hairline-bright)",
  background: "var(--ink-raised)",
  padding: "6px 14px",
  borderRadius: 3,
  cursor: "pointer",
  color: "var(--text)",
};

const activeBtnStyle: CSSProperties = {
  ...btnStyle,
  borderColor: "var(--text-dim)",
  background: "var(--hairline)",
};

const subTabStyle: CSSProperties = {
  padding: "10px 4px",
  marginBottom: -1,
  borderBottom: "2px solid transparent",
  color: "var(--text-dim)",
  cursor: "pointer",
};

const activeSubTabStyle: CSSProperties = {
  ...subTabStyle,
  borderBottomColor: "var(--text)",
  color: "var(--text)",
};

type Tab = "tournament" | "history";
type HistoryView = "tournaments" | "factions" | "players";

const TOURNAMENT_VIEWS: [TournamentView, string][] = [["factions", "Factions"], ["players", "Players"], ["zones", "Zones"]];
// Battle-report reconstructions carry no launch series, so there is nothing for a Factions view to chart.
const DERIVED_VIEWS = TOURNAMENT_VIEWS.filter(([v]) => v !== "factions");
const HISTORY_VIEWS: [HistoryView, string][] = [["tournaments", "Tournaments"], ["factions", "Factions"], ["players", "Players"]];

// Links shared before the two-level layout carry tab=dashboard|history|alltime|factions.
function resolveNav(tab: string | null, view: string | null): { tab: Tab; view: string } {
  if (tab === "alltime") return { tab: "history", view: "players" };
  if (tab === "factions") return { tab: "history", view: "factions" };
  if (tab === "history") {
    return { tab, view: HISTORY_VIEWS.some(([v]) => v === view) ? view! : "tournaments" };
  }
  return { tab: "tournament", view: TOURNAMENT_VIEWS.some(([v]) => v === view) ? view! : "players" };
}

function SubTabs({ views, active, onSelect }: { views: [string, string][]; active: string; onSelect: (v: string) => void }) {
  return (
    <nav style={{ display: "flex", gap: 20, padding: "0 16px", borderBottom: "1px solid var(--hairline)", borderTop: "1px solid var(--hairline)" }}>
      {views.map(([v, label]) => (
        <button key={v} type="button" onClick={() => onSelect(v)} style={active === v ? activeSubTabStyle : subTabStyle}>
          {label}
        </button>
      ))}
    </nav>
  );
}

export default function AtlantisPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [index, setIndex] = useState<AtlantisIndex | null>(null);
  const [monthData, setMonthData] = useState<MonthPayload | DerivedMonthPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const selectedMonth = searchParams.get("t");
  const playerParam = searchParams.get("player");
  const nav = resolveNav(searchParams.get("tab"), searchParams.get("view"));

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const p = new URLSearchParams(searchParams.toString());
      if (value) p.set(key, value);
      else p.delete(key);
      router.replace(`/atlantis/?${p.toString()}`, { scroll: false });
    },
    [searchParams, router],
  );

  const setParams = useCallback(
    (updates: Record<string, string | null>) => {
      const p = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value) p.set(key, value);
        else p.delete(key);
      }
      router.replace(`/atlantis/?${p.toString()}`, { scroll: false });
    },
    [searchParams, router],
  );

  useEffect(() => {
    let live = true;
    fetchIndex(BASE).then(
      (idx) => { if (live) setIndex(idx); },
      (err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)); },
    ).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const allTournaments = useMemo(() => index ? mergedTournaments(index) : [], [index]);

  const resolvedMonth = selectedMonth
    ?? (index?.tournaments.length ? index.tournaments[index.tournaments.length - 1].month : null)
    ?? (allTournaments.length ? allTournaments[allTournaments.length - 1].month : null);

  const selectedTournament: AnyTournament | null =
    allTournaments.find((t) => t.month === resolvedMonth) ?? null;

  const derivedSelected = selectedTournament && isDerived(selectedTournament);

  useEffect(() => {
    if (!resolvedMonth || !selectedTournament) return;
    let live = true;
    setMonthData(null);
    const fetcher = isDerived(selectedTournament)
      ? fetchDerivedMonth(BASE, resolvedMonth)
      : fetchMonth(BASE, resolvedMonth);
    fetcher.then(
      (m) => { if (live) setMonthData(m); },
      (err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { live = false; };
  }, [resolvedMonth, selectedTournament]);

  const boardMonth = !derivedSelected && monthData && "observations" in monthData ? monthData as MonthPayload : null;
  const derivedMonth = derivedSelected && monthData && "zones" in monthData && Array.isArray((monthData as DerivedMonthPayload).zones) ? monthData as DerivedMonthPayload : null;

  const boardTournament = selectedTournament && !isDerived(selectedTournament) ? selectedTournament : null;
  const derivedTournament = selectedTournament && isDerived(selectedTournament) ? selectedTournament as DerivedTournamentSummary : null;

  const obsTimestamps = boardMonth ? parseObsTimestamps(boardMonth.observations) : [];

  const zoneParam = searchParams.get("zone");

  const playerParts = playerParam?.split(":") ?? null;
  const playerFaction = playerParts?.[0] ?? null;
  const playerName = playerParts?.slice(1).join(":") ?? null;

  const onPlayerClick = (faction: string, name: string) =>
    setParam("player", `${faction}:${name}`);
  const onPlayerClose = () => setParam("player", null);
  const onZoneClick = (key: string) => setParam("zone", key);
  const onZoneClose = () => setParam("zone", null);
  const selectView = (view: string) => setParams({ tab: nav.tab === "tournament" ? null : nav.tab, view, player: null, zone: null });

  const scheduleText = selectedTournament
    ? `Stacking ${selectedTournament.stacking_days}d, battle ${selectedTournament.battle_days}d`
      + (derivedTournament?.end_tolerance_days === 1 ? " ±1 d" : "")
      + " · "
      + formatDate(selectedTournament.starts_at) + " to " + formatDate(selectedTournament.ends_at)
    : null;

  return (
    <main style={{ height: "100dvh", overflow: "auto", background: "var(--ink)", color: "var(--text)" }}>
      <header style={{ ...panel, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <h1 className="display" style={{ margin: 0, fontSize: 18 }}>Atlantis</h1>
          <SiteNav />
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          {(["tournament", "history"] as Tab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setParams({ tab: tab === "tournament" ? null : tab, view: null, player: null, zone: null })}
              style={nav.tab === tab ? activeBtnStyle : btnStyle}
            >
              {tab === "tournament" ? "Tournament" : "All time"}
            </button>
          ))}
        </div>

        {nav.tab === "tournament" && allTournaments.length > 1 ? (
          <select
            value={resolvedMonth ?? ""}
            onChange={(e) => setParam("t", e.target.value)}
            aria-label="Tournament month"
            style={{ ...btnStyle, appearance: "auto" }}
          >
            {[...allTournaments].reverse().map((t) => {
              const suffix = t.winner ? " — " + t.winner : "";
              return <option key={t.month} value={t.month}>{t.month}{suffix}</option>;
            })}
          </select>
        ) : null}

        {nav.tab === "tournament" && scheduleText ? (
          <span style={{ color: "var(--text-dim)", marginLeft: "auto" }}>{scheduleText}</span>
        ) : null}
      </header>

      {error ? (
        <div style={{ padding: 16, color: "var(--legion)" }}>{error}</div>
      ) : loading ? (
        <div style={{ padding: 16, color: "var(--text-dim)" }}>Loading…</div>
      ) : nav.tab === "tournament" && derivedMonth && derivedTournament ? (
        <DerivedDashboard
          month={derivedMonth}
          tournament={derivedTournament}
          view={nav.view as TournamentView}
          subNav={<SubTabs views={DERIVED_VIEWS} active={nav.view === "factions" ? "players" : nav.view} onSelect={selectView} />}
        />
      ) : nav.tab === "tournament" && boardMonth && boardTournament ? (
        <>
          <Dashboard
            month={boardMonth}
            tournament={boardTournament}
            view={nav.view as TournamentView}
            subNav={<SubTabs views={TOURNAMENT_VIEWS} active={nav.view} onSelect={selectView} />}
            onPlayerClick={onPlayerClick}
            onZoneClick={onZoneClick}
          />
          {!derivedSelected && playerFaction && playerName && boardMonth.players[playerFaction]?.[playerName] ? (
            <PlayerDetail
              faction={playerFaction}
              playerName={playerName}
              month={boardMonth}
              obsTimestamps={obsTimestamps}
              onClose={onPlayerClose}
            />
          ) : null}
          {!derivedSelected && zoneParam && boardMonth.zones[zoneParam] ? (
            <ZoneDetail
              zoneKey={zoneParam}
              month={boardMonth}
              obsTimestamps={obsTimestamps}
              onClose={onZoneClose}
            />
          ) : null}
        </>
      ) : nav.tab === "history" && index ? (
        <>
          <SubTabs views={HISTORY_VIEWS} active={nav.view} onSelect={selectView} />
          {nav.view === "players" ? (
            <AllTime index={index} />
          ) : nav.view === "factions" ? (
            <Factions index={index} />
          ) : (
            <History index={index} onMonthClick={(m) => setParams({ t: m, tab: null, view: null })} />
          )}
        </>
      ) : !monthData ? (
        <div style={{ padding: 16, color: "var(--text-dim)" }}>Loading month…</div>
      ) : null}
    </main>
  );
}
