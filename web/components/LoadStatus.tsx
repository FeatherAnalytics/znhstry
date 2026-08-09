"use client";

import type { LoadProgress } from "@/lib/useZoneData";

/**
 * What is still arriving, said plainly.
 *
 * The map is usable long before it is complete, so the honest thing is a
 * running count of what is on screen rather than a spinner that implies
 * nothing works yet. It fades out once the world is whole and only the
 * background history is still filling in.
 */
export function LoadStatus({
  progress,
  totalZones,
}: {
  progress: LoadProgress;
  totalZones: number;
}) {
  const streaming = progress.stage === "zones";

  if (progress.error) {
    return (
      <div style={shell} role="status">
        <span style={{ color: "var(--legion)" }}>{progress.error}</span>
      </div>
    );
  }
  // Scrubbing only says anything while the world is still arriving. Once it is
  // whole, a date lands in a couple of megabytes and the panel's own date is
  // the feedback; a status box that flickers on every drag frame is noise.
  if (!streaming) return null;

  const pct = totalZones ? Math.min(100, (progress.zones / totalZones) * 100) : 0;

  return (
    <div style={shell} role="status" aria-live="polite">
      <span className="tabular">{progress.zones.toLocaleString()}</span>
      <span style={{ color: "var(--text-dim)" }}> of {totalZones.toLocaleString()} zones</span>
      <div style={track}>
        <div style={{ ...bar, width: `${pct}%` }} />
      </div>
    </div>
  );
}

const shell: React.CSSProperties = {
  position: "absolute",
  left: 16,
  bottom: 16,
  zIndex: 10,
  padding: "7px 11px",
  fontSize: 11,
  background: "rgba(10,13,19,0.86)",
  backdropFilter: "var(--panel-blur)",
  WebkitBackdropFilter: "var(--panel-blur)",
  border: "1px solid var(--hairline-bright)",
  minWidth: 210,
};

const track: React.CSSProperties = {
  height: 2,
  background: "var(--hairline)",
  marginTop: 6,
};

const bar: React.CSSProperties = {
  height: "100%",
  background: "var(--text-dim)",
  transition: "width 180ms linear",
};
