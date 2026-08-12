"use client";

import { EMPHASIS, EMPHASIS_ALL, type EmphasisKey } from "@/lib/emphasis";

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

/**
 * Zones by leading faction, and the two kinds of zone nobody holds.
 *
 * Its own type rather than more fields on `Totals`, so bots and zones cannot be
 * passed where the other is expected. Both describe the same selection on the
 * same date, and they are not interchangeable: a faction can lead many zones
 * thinly or one zone deeply.
 *
 * "Leads" and never "controls" - the faction here is whoever has the most bots
 * standing, which is what the map colours by. `control_state` keeps naming
 * whoever captured a zone last long after their last bot has gone, and counting
 * that reports every zone ever taken as currently held.
 *
 * Null while the panel is reporting change: a per-faction zone count is a level,
 * and "which faction gained most zones" is the thing the map refuses to colour
 * by, because it makes one vocabulary mean two things.
 */
export interface FactionZones {
  legion: number;
  swarm: number;
  faceless: number;
  /** Real places with no bot in the whole record. Constant, not a count. */
  neverPlayed: number;
  /** Held something once, holds nothing now. */
  emptied: number;
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
  /** Zones by leading faction for the same selection, or null in change mode. */
  zones: FactionZones | null;
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
  /**
   * Net bots across a run so far, shown small under the total.
   *
   * The timelapse's own question - what has this period done - which the rows
   * above cannot answer while they are reporting levels for one date.
   */
  since?: { label: string; value: number } | null;
  /**
   * Which of the five categories the map is lighting, as `EMPHASIS` bits.
   *
   * The rows are the control for it, so the panel needs to know the state to draw
   * itself dimmed in step with the dots.
   */
  emphasis?: number;
  onEmphasis?: (key: EmphasisKey) => void;
  /**
   * Rendered inside the panel, under the hover readout. The region breakdown
   * lives here rather than in a box of its own so there is one card with one
   * border, and so a long region list scrolls with the numbers it belongs to.
   */
  children?: React.ReactNode;
}

const FACTION_NAMES = ["Uncaptured", "Legion", "Swarm", "Faceless"];

export function compactNumber(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return String(value);
}

/**
 * Every figure in the panel, in full.
 *
 * The five zone categories are meant to add up to the total, and "422K + 625K +
 * 514K + 34K + 1.1M" cannot be checked against "2.7M" by anyone. Grouped so the
 * eye can size it without counting digits.
 */
export function exactNumber(value: number): string {
  return (value < 0 ? -value : value).toLocaleString("en-US");
}

/** Exact, and signed when the panel is reporting movement rather than a level. */
function figure(value: number, signed: boolean): string {
  return `${signed && value > 0 ? "+" : signed && value < 0 ? "−" : ""}${exactNumber(value)}`;
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

/**
 * One row of the breakdown: a heading, then its numbers underneath.
 *
 * Stacked rather than in columns because the figures are exact - fourteen digits
 * of bots will not share a 268 px line with a zone count and a growth delta, and
 * shortening them was the thing being fixed.
 *
 * A row with an `onSelect` is a button: the map dims every category the reader
 * has not asked for, so the control belongs on the row that names the category
 * rather than in a legend somewhere else.
 */
function Row({
  label,
  swatch,
  aside,
  bots,
  zones,
  bar,
  strong = false,
  lit = true,
  onSelect,
}: {
  label: string;
  swatch?: string;
  aside?: React.ReactNode;
  bots?: string | null;
  zones?: string | null;
  bar?: React.ReactNode;
  strong?: boolean;
  /** False while some other category is the one being emphasised. */
  lit?: boolean;
  onSelect?: () => void;
}) {
  const body = (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        {swatch ? (
          <span
            aria-hidden
            style={{ width: 7, height: 7, background: swatch, flexShrink: 0 }}
          />
        ) : (
          // Aligns with the rows that do have a swatch.
          <span aria-hidden style={{ width: 7, flexShrink: 0 }} />
        )}
        <span style={{ flex: 1, color: strong ? "var(--text)" : "var(--text-dim)" }}>{label}</span>
        {aside}
      </div>
      {bots && (
        <div
          className="tabular"
          style={{ marginLeft: 15, marginTop: 2, fontWeight: strong ? 600 : 500 }}
        >
          {bots} <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>bots</span>
        </div>
      )}
      {zones && (
        <div
          className="tabular"
          style={{ marginLeft: 15, marginTop: 1, color: "var(--text-dim)", fontSize: 11 }}
        >
          {zones} zones
        </div>
      )}
      {bar}
    </>
  );

  if (!onSelect) return <div style={{ marginBottom: 10 }}>{body}</div>;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={lit}
      title={lit ? `Isolate ${label} on the map` : `Add ${label} back to the map`}
      style={{
        display: "block",
        width: "100%",
        marginBottom: 10,
        padding: 0,
        border: "none",
        background: "none",
        font: "inherit",
        color: "inherit",
        textAlign: "left",
        cursor: "pointer",
        // Dimmed to match what the map does to the dots, so the row and the
        // world it describes read as one state rather than two.
        opacity: lit ? 1 : 0.38,
      }}
    >
      {body}
    </button>
  );
}

export function StatsPanel({
  date,
  totals,
  zones,
  previous,
  zoneCount,
  activeCount,
  scopeLabel,
  hovered,
  stateReady,
  changeLabel,
  pending,
  compact = false,
  since,
  emphasis = EMPHASIS_ALL,
  onEmphasis,
  children,
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
              // A long region list scrolls with the numbers it belongs to rather
              // than pushing the card off the screen.
              maxHeight: "calc(100vh - 32px)",
              overflowY: "auto",
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
      {/* Every zone in the selection, the 1.09M never played included: they are
          real places and part of the world the rows below break down. */}
      <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
        {changeLabel ? (
          <>
            {pending ? "Reading" : `${exactNumber(totals.held)} zones moved`} &middot; {changeLabel}
          </>
        ) : (
          <>
            {exactNumber(zoneCount)} zones
            {pending ? " · reading" : stateReady ? "" : " · reading state"}
          </>
        )}
      </div>

      <div style={{ height: 1, background: "var(--hairline)", margin: "14px 0 12px" }} />

      {FACTIONS.map((faction) => {
        const value = totals[faction.key];
        return (
          <Row
            key={faction.key}
            label={faction.label}
            swatch={faction.color}
            lit={(emphasis & EMPHASIS[faction.key]) !== 0}
            onSelect={onEmphasis ? () => onEmphasis(faction.key) : undefined}
            aside={!changeLabel ? <Delta now={value} then={previous?.[faction.key]} /> : undefined}
            bots={pending ? "—" : figure(value, changeLabel !== null)}
            /* Zones led, beside the bots standing. The pair is the point: a
               faction can lead many zones thinly or one zone deeply. */
            zones={zones && !pending ? exactNumber(zones[faction.key]) : null}
            bar={
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
            }
          />
        );
      })}

      {zones && !pending && (
        <>
          <div style={{ height: 1, background: "var(--hairline)", margin: "12px 0 10px" }} />
          {/* The number every share above is a share of. The bot side is a sum of
              approximations for a circle or the viewport; the zone side is exact
              for every selection, so the qualifier belongs on one and not both. */}
          <Row
            label="Total"
            strong
            bots={figure(totals.legion + totals.swarm + totals.faceless, changeLabel !== null)}
            zones={exactNumber(zoneCount)}
          />
          {/* Smaller than the total it hangs off: the run's movement is context for
              the level above it, not a competing headline. */}
          {since && (
            <div
              style={{
                marginLeft: 15,
                marginBottom: 10,
                fontSize: 11,
                color: "var(--text-dim)",
              }}
            >
              {since.label}{" "}
              <span className="tabular" style={{ color: "var(--text)" }}>
                {figure(since.value, true)}
              </span>{" "}
              bots
            </div>
          )}
          {/* Two kinds of nothing, matching the two shades of grey on the map. No
              bot figure: there is nothing standing in either of them. */}
          <Row
            label="Empty"
            lit={(emphasis & EMPHASIS.empty) !== 0}
            onSelect={onEmphasis ? () => onEmphasis("empty") : undefined}
            zones={exactNumber(zones.emptied)}
          />
          <Row
            label="Never played"
            lit={(emphasis & EMPHASIS.neverPlayed) !== 0}
            onSelect={onEmphasis ? () => onEmphasis("neverPlayed") : undefined}
            zones={exactNumber(zones.neverPlayed)}
          />
        </>
      )}

      {/* Subordinate rows - a country's regions - sit under the totals they break
          down and above the hover, which is about one zone and belongs last. */}
      {children}

      <div style={{ height: 1, background: "var(--hairline)", margin: "12px 0 10px" }} />
      <div style={{ minHeight: 46 }}>
        {hovered ? (
          <>
            <div style={{ fontWeight: 600 }}>{hovered.name || "Unnamed zone"}</div>
            {/* Both labels are the zone's own ids, which is what the game shows.
                For 447 zones the pair reads as nonsense - a Polish voivodeship
                beside the Solomon Islands - and it is upstream's nonsense, kept so
                the hover agrees with the region totals counted the same way. */}
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
