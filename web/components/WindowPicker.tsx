"use client";

import { VIEWS, type ViewKey } from "@/lib/windows";

interface Props {
  view: ViewKey;
  onView: (view: ViewKey) => void;
  /** Draw zones holding no bots, as grey terrain. */
  uncapped: boolean;
  onUncapped: (show: boolean) => void;
  /** True while the view's zones are still being worked out. */
  pending: boolean;
}

const chip = (active: boolean): React.CSSProperties => ({
  padding: "4px 8px",
  border: `1px solid ${active ? "var(--text-dim)" : "transparent"}`,
  background: active ? "var(--hairline)" : "transparent",
  color: active ? "var(--text)" : "var(--text-dim)",
  whiteSpace: "nowrap",
});

/**
 * One row: what the map is being asked.
 *
 * Current and the windows are peers, one row of mutually exclusive choices,
 * because they are alternative questions rather than modifiers of one another.
 * Pairing a window with a separate "show everything" toggle makes half the
 * combinations duplicates and implies the window means something it doesn't.
 */
export function WindowPicker({ view, onView, uncapped, onUncapped, pending }: Props) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ display: "flex", gap: 2 }} role="group" aria-label="View">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            className="eyebrow"
            onClick={() => onView(v.key)}
            aria-pressed={view === v.key}
            style={{
              ...chip(view === v.key),
              // Current is a different kind of question from the windows, so it
              // gets a rule between it and them rather than sitting in the row
              // as if it were another duration.
              marginRight: v.key === "current" ? 8 : 0,
              borderRight:
                v.key === "current" ? "1px solid var(--hairline-bright)" : undefined,
              paddingRight: v.key === "current" ? 12 : 8,
            }}
            title={v.title}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* Off by default. A zone with no bots is a real place and part of the
          world, but two million grey dots also drown the ones being fought
          over, and that is what a reader came for. */}
      <button
        className="eyebrow"
        onClick={() => onUncapped(!uncapped)}
        aria-pressed={uncapped}
        style={chip(uncapped)}
        title="Draw zones holding no bots, including the 1.09M never played"
      >
        Empty zones
      </button>

      {pending && (
        <span className="eyebrow" aria-live="polite">
          Reading&hellip;
        </span>
      )}
    </div>
  );
}
