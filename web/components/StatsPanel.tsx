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
  /**
   * True while the count is read off the map's own log bucket rather than the
   * record. The zone's exact history is a ~150 KB block away and lands within
   * a hover, so this is what the first frame of a readout says rather than a
   * confident number it has not checked.
   */
  approximate: boolean;
  /** False for a zone that has never held a bot in fourteen years. */
  everActive: boolean;
  zoneId?: number;
  region?: string | null;
  country?: string | null;
}

interface Props {
  date: Date;
  totals: Totals;
  previous: Totals | null;
  /** Zones in the current filter, or the whole scope when there is none. */
  zoneCount: number;
  /** Zones anywhere that have ever held a bot. */
  activeCount: number;
  scopeLabel: string;
  hovered: HoveredZone | null;
  stateReady: boolean;
  /** Set when the panel is reporting movement across a window, not levels. */
  changeLabel: string | null;
  /** True while the exact counts for this selection are still being read. */
  pending: boolean;
  /**
   * Rendered inside the bottom sheet rather than floating over the map.
   *
   * The floating card is 268px, which is 69% of a 390px screen — it stops being
   * an overlay and becomes the page. In the sheet it is just content: full
   * width, no chrome of its own, and the date lives in the sheet's summary line
   * so it is not repeated here.
   */
  compact?: boolean;
}

const FACTION_NAMES = ["Uncaptured", "Legion", "Swarm", "Faceless"];

export function compactNumber(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return String(value);
}

function Delta({ now, then }: { now: number; then: number | undefined }) {
  if (then === undefined || then === 0) return null;
  const growth = now / then;
  if (!isFinite(growth)) return null;
  // In the early years a faction could multiply many times over in a year, and
  // "+41,000%" is noise. Past tenfold it reads as a multiple instead.
  const label =
    growth >= 10
      ? `${growth.toFixed(0)}x`
      : Math.abs((growth - 1) * 100) < 0.05
        ? null
        : `${growth > 1 ? "+" : ""}${((growth - 1) * 100).toFixed(1)}%`;
  if (!label) return null;
  return (
    <span style={{ color: "var(--text-dim)", marginLeft: 6, fontSize: 11 }}>{label}</span>
  );
}

export function StatsPanel({
  date,
  totals,
  previous,
  zoneCount,
  activeCount,
  scopeLabel,
  hovered,
  stateReady,
  changeLabel,
  pending,
  compact = false,
}: Props) {
  // Bars are shares of the movement, so a negative faction gets no bar rather
  // than a nonsensical negative width.
  const sum =
    Math.abs(totals.legion) + Math.abs(totals.swarm) + Math.abs(totals.faceless) || 1;

  return (
    <aside
      style={
        compact
          ? { padding: "0 16px 16px" }
          : {
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
            }
      }
    >
      <div className="eyebrow">{scopeLabel}</div>
      {/* The sheet's summary line already carries the date. */}
      {!compact && (
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
      )}
      {/* Zones holding bots right now, against every zone on the map -
          including the 1.09M that have never been played, which are part of
          the world and part of the denominator. */}
      <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
        {changeLabel ? (
          <>
            {pending ? "Reading" : `${compactNumber(totals.held)} zones moved`} &middot; {changeLabel}
          </>
        ) : (
          <>
            {/* `held` belongs to whatever `totals` describes. While a
                selection's exact counts are still being read, `totals` is
                still the global figure, and pairing it with the selection's
                zone count reads as "1.6M of 147K occupied". Show one or the
                other, never a mismatched pair. */}
            {stateReady && !pending ? `${compactNumber(totals.held)} of ` : ""}
            {compactNumber(zoneCount)} zones
            {pending ? " · reading" : stateReady ? " occupied" : " · reading state"}
          </>
        )}
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
                {pending ? (
                  <span style={{ color: "var(--text-dim)" }}>&mdash;</span>
                ) : (
                  <>
                    {changeLabel && value > 0 ? "+" : ""}
                    {compactNumber(value)}
                  </>
                )}
              </span>
              {!changeLabel && <Delta now={value} then={previous?.[faction.key]} />}
            </div>
            <div style={{ height: 3, background: "var(--hairline)", marginTop: 5 }}>
              <div
                style={{
                  height: "100%",
                  width: `${(Math.abs(value) / sum) * 100}%`,
                  // A faction that shed bots over the window still gets a bar,
                  // drawn hollow, so a loss is visible rather than absent.
                  background: value < 0 ? "transparent" : faction.color,
                  border: value < 0 ? `1px solid ${faction.color}` : undefined,
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
              {hovered.total > 0
                ? `${FACTION_NAMES[hovered.faction]} · ${hovered.approximate ? "~" : ""}${compactNumber(hovered.total)} bots`
                : hovered.everActive
                  ? "Empty · fought over before"
                  : "Never played"}
              {hovered.zoneId !== undefined && (
                <span className="tabular" style={{ marginLeft: 6, opacity: 0.75 }}>
                  #{hovered.zoneId}
                </span>
              )}
            </div>
          </>
        ) : (
          // No hover on a touch screen, and the compact layout is where those
          // land, so the instruction has to match the gesture that works.
          <div className="eyebrow">{compact ? "Tap a zone" : "Hover a zone"}</div>
        )}
      </div>
    </aside>
  );
}
