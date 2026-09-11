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
import Dashboard from "./Dashboard";
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

type Tab = "dashboard" | "history" | "alltime" | "factions";

export default function AtlantisPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [index, setIndex] = useState<AtlantisIndex | null>(null);
  const [monthData, setMonthData] = useState<MonthPayload | DerivedMonthPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const selectedMonth = searchParams.get("t");
  const playerParam = searchParams.get("player");
  const TABS: Tab[] = ["dashboard", "history", "alltime", "factions"];
  const rawTab = searchParams.get("tab") ?? "dashboard";
  const tabParam: Tab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : "dashboard";

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

        {allTournaments.length > 1 ? (
          <select
            value={resolvedMonth ?? ""}
            onChange={(e) => setParam("t", e.target.value)}
            style={{ ...btnStyle, appearance: "auto" }}
          >
            {[...allTournaments].reverse().map((t) => {
              const suffix = (t.winner ? " — " + t.winner : "") + (isDerived(t) ? " derived" : "");
              return <option key={t.month} value={t.month}>{t.month}{suffix}</option>;
            })}
          </select>
        ) : null}

        <div style={{ display: "flex", gap: 6 }}>
          {(["dashboard", "history", "alltime", "factions"] as Tab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setParams({ tab: tab === "dashboard" ? null : tab, player: null, zone: null })}
              style={tabParam === tab ? activeBtnStyle : btnStyle}
            >
              {tab === "dashboard" ? "Leaderboard" : tab === "history" ? "History" : tab === "alltime" ? "Players" : "Factions"}
            </button>
          ))}
        </div>

        {scheduleText ? (
          <span style={{ color: "var(--text-dim)", marginLeft: "auto" }}>{scheduleText}</span>
        ) : null}
      </header>

      {error ? (
        <div style={{ padding: 16, color: "var(--legion)" }}>{error}</div>
      ) : loading ? (
        <div style={{ padding: 16, color: "var(--text-dim)" }}>Loading…</div>
      ) : tabParam === "dashboard" && derivedMonth && derivedTournament ? (
        <DerivedDashboard month={derivedMonth} tournament={derivedTournament} />
      ) : tabParam === "dashboard" && boardMonth && boardTournament ? (
        <>
          <Dashboard
            month={boardMonth}
            tournament={boardTournament}
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
      ) : tabParam === "history" && index ? (
        <History index={index} onMonthClick={(m) => setParams({ t: m, tab: null })} />
      ) : tabParam === "alltime" && index ? (
        <AllTime index={index} />
      ) : tabParam === "factions" && index ? (
        <Factions index={index} />
      ) : !monthData ? (
        <div style={{ padding: 16, color: "var(--text-dim)" }}>Loading month…</div>
      ) : null}
    </main>
  );
}
