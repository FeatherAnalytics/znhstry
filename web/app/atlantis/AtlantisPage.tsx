"use client";

import { useEffect, useState, useCallback, type CSSProperties } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { BASE } from "@/lib/dataOrigin";
import {
  fetchIndex,
  fetchMonth,
  parseObsTimestamps,
  formatDate,
  type AtlantisIndex,
  type MonthPayload,
  type TournamentSummary,
} from "./lib";
import Dashboard from "./Dashboard";
import PlayerDetail from "./PlayerDetail";

const panel: CSSProperties = {
  borderBottom: "1px solid var(--hairline)",
  padding: "12px 16px",
};

const btnStyle: CSSProperties = {
  border: "1px solid var(--hairline-bright)",
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

type Tab = "dashboard" | "history" | "alltime";

export default function AtlantisPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [index, setIndex] = useState<AtlantisIndex | null>(null);
  const [month, setMonth] = useState<MonthPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const selectedMonth = searchParams.get("t");
  const playerParam = searchParams.get("player");
  const tabParam = (searchParams.get("tab") ?? "dashboard") as Tab;

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const p = new URLSearchParams(searchParams.toString());
      if (value) p.set(key, value);
      else p.delete(key);
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

  const resolvedMonth = selectedMonth ?? index?.tournaments[index.tournaments.length - 1]?.month ?? null;

  useEffect(() => {
    if (!resolvedMonth) return;
    let live = true;
    setMonth(null);
    fetchMonth(BASE, resolvedMonth).then(
      (m) => { if (live) setMonth(m); },
      (err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { live = false; };
  }, [resolvedMonth]);

  const tournament: TournamentSummary | null =
    index?.tournaments.find((t) => t.month === resolvedMonth) ?? null;

  const obsTimestamps = month ? parseObsTimestamps(month.observations) : [];

  const playerParts = playerParam?.split(":") ?? null;
  const playerFaction = playerParts?.[0] ?? null;
  const playerName = playerParts?.slice(1).join(":") ?? null;

  const onPlayerClick = (faction: string, name: string) =>
    setParam("player", `${faction}:${name}`);
  const onPlayerClose = () => setParam("player", null);

  return (
    <main style={{ height: "100dvh", overflow: "auto", background: "var(--ink)", color: "var(--text)" }}>
      <header style={{ ...panel, display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
        <h1 className="display" style={{ margin: 0, fontSize: 18 }}>Atlantis</h1>

        {index && index.tournaments.length > 1 ? (
          <select
            value={resolvedMonth ?? ""}
            onChange={(e) => setParam("t", e.target.value)}
            style={{ ...btnStyle, appearance: "auto" }}
          >
            {index.tournaments.map((t) => (
              <option key={t.month} value={t.month}>
                {t.month}{t.winner ? ` — ${t.winner}` : ""}
              </option>
            ))}
          </select>
        ) : null}

        <div style={{ display: "flex", gap: 6 }}>
          {(["dashboard", "history", "alltime"] as Tab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setParam("tab", tab === "dashboard" ? null : tab)}
              style={tabParam === tab ? activeBtnStyle : btnStyle}
            >
              {tab === "dashboard" ? "Dashboard" : tab === "history" ? "History" : "All Time"}
            </button>
          ))}
        </div>

        {tournament ? (
          <span style={{ color: "var(--text-dim)", marginLeft: "auto" }}>
            Stacking {tournament.stacking_days}d, battle {tournament.battle_days}d
            {" · "}
            {formatDate(tournament.starts_at)} to {formatDate(tournament.ends_at)}
          </span>
        ) : null}
      </header>

      {error ? (
        <div style={{ padding: 16, color: "var(--legion)" }}>{error}</div>
      ) : loading ? (
        <div style={{ padding: 16, color: "var(--text-dim)" }}>Loading…</div>
      ) : tabParam === "dashboard" && month && tournament ? (
        <>
          <Dashboard
            month={month}
            tournament={tournament}
            onPlayerClick={onPlayerClick}
          />
          {playerFaction && playerName && month.players[playerFaction]?.[playerName] ? (
            <PlayerDetail
              faction={playerFaction}
              playerName={playerName}
              month={month}
              obsTimestamps={obsTimestamps}
              onClose={onPlayerClose}
            />
          ) : null}
        </>
      ) : tabParam === "history" ? (
        <div style={{ padding: 16, color: "var(--text-dim)" }}>History — coming in phase 4.</div>
      ) : tabParam === "alltime" ? (
        <div style={{ padding: 16, color: "var(--text-dim)" }}>All Time — coming in phase 4.</div>
      ) : !month ? (
        <div style={{ padding: 16, color: "var(--text-dim)" }}>Loading month…</div>
      ) : null}
    </main>
  );
}
