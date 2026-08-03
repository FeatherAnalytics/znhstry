"use client";

// Alphabetical, so the reading order does not imply a ranking.
const FACTIONS = [
  { key: "faceless", label: "Faceless", color: "var(--faceless)" },
  { key: "legion", label: "Legion", color: "var(--legion)" },
  { key: "swarm", label: "Swarm", color: "var(--swarm)" },
] as const;

export interface Totals {
  legion: number;
  swarm: number;
  faceless: number;
  held: number;
}

export interface HoveredZone {
  name: string;
  total: number;
  faction: number;
  zoneId?: number;
  region?: string | null;
  country?: string | null;
}

interface Props {
  date: Date;
  totals: Totals;
  previous: Totals | null;
  zoneCount: number;
  scopeLabel: string;
  hovered: HoveredZone | null;
}

const FACTION_NAMES = ["Uncaptured", "Legion", "Swarm", "Faceless"];

function compact(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return String(value);
}

function Delta({ now, then }: { now: number; then: number | undefined }) {
  if (then === undefined || then === 0) return null;
  const change = ((now - then) / then) * 100;
  if (!isFinite(change) || Math.abs(change) < 0.05) return null;
  return (
    <span style={{ color: "var(--text-dim)", marginLeft: 6, fontSize: 11 }}>
      {change > 0 ? "+" : ""}
      {change.toFixed(1)}%
    </span>
  );
}

export function StatsPanel({ date, totals, previous, zoneCount, scopeLabel, hovered }: Props) {
  const sum = totals.legion + totals.swarm + totals.faceless || 1;

  return (
    <aside
      style={{
        position: "absolute",
        top: 16,
        right: 16,
        width: 268,
        padding: "16px 18px 18px",
        background: "rgba(14,18,24,0.82)",
        backdropFilter: "var(--panel-blur)",
        WebkitBackdropFilter: "var(--panel-blur)",
        border: "1px solid var(--hairline-bright)",
        zIndex: 10,
      }}
    >
      <div className="eyebrow">{scopeLabel}</div>
      <div
        className="display tabular"
        style={{ fontSize: 26, lineHeight: 1.1, margin: "6px 0 2px" }}
      >
        {date.toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        })}
      </div>
      <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
        {compact(totals.held)} of {compact(zoneCount)} zones held
      </div>

      <div style={{ height: 1, background: "var(--hairline)", margin: "14px 0 12px" }} />

      {FACTIONS.map((faction) => {
        const value = totals[faction.key];
        return (
          <div key={faction.key} style={{ marginBottom: 11 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span
                aria-hidden
                style={{ width: 7, height: 7, background: faction.color, flexShrink: 0 }}
              />
              <span style={{ flex: 1, color: "var(--text-dim)" }}>{faction.label}</span>
              <span className="tabular" style={{ fontWeight: 600 }}>
                {compact(value)}
              </span>
              <Delta now={value} then={previous?.[faction.key]} />
            </div>
            <div style={{ height: 3, background: "var(--hairline)", marginTop: 5 }}>
              <div
                style={{
                  height: "100%",
                  width: `${(value / sum) * 100}%`,
                  background: faction.color,
                }}
              />
            </div>
          </div>
        );
      })}

      <div style={{ height: 1, background: "var(--hairline)", margin: "12px 0 10px" }} />
      <div style={{ minHeight: 46 }}>
        {hovered ? (
          <>
            <div style={{ fontWeight: 600 }}>{hovered.name || "Unnamed zone"}</div>
            {/* Region is omitted, not blanked, when the upstream region_id
                contradicts the zone's own country. */}
            {(hovered.region || hovered.country) && (
              <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
                {[hovered.region, hovered.country].filter(Boolean).join(" · ")}
              </div>
            )}
            <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
              {FACTION_NAMES[hovered.faction]} &middot; {compact(hovered.total)} bots
              {hovered.zoneId !== undefined && (
                <span className="tabular" style={{ marginLeft: 6, opacity: 0.75 }}>
                  #{hovered.zoneId}
                </span>
              )}
            </div>
          </>
        ) : (
          <div className="eyebrow">Hover a zone</div>
        )}
      </div>
    </aside>
  );
}
