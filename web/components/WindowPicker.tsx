"use client";

import { VIEWS, type ViewKey } from "@/lib/windows";

interface Props {
  view: ViewKey;
  onView: (view: ViewKey) => void;
  /** True when the map is showing empty zones and nothing else. */
  emptyOnly: boolean;
  onEmptyOnly: (only: boolean) => void;
  /** True while the view's zones are still being worked out. */
  pending: boolean;
  /**
   * Scroll the row instead of wrapping it.
   *
   * At 390px the full row is 1,022px wide. Wrapping would push the map off the
   * screen; scrolling keeps every control one swipe away and the map intact.
   */
  scrollable?: boolean;
}

/**
 * Longhand per side, never the `border` or `padding` shorthands.
 *
 * Callers override a single side - `Current` gets its own right border and wider
 * right padding - and React cannot reconcile a shorthand against a longhand for the
 * same value. On re-render it applies whichever it sees last, so switching view
 * would drop or resurrect that divider depending on prop order.
 */
const chip = (active: boolean): React.CSSProperties => {
  const line = `1px solid ${active ? "var(--text-dim)" : "transparent"}`;
  return {
    paddingTop: 4,
    paddingBottom: 4,
    paddingLeft: 8,
    paddingRight: 8,
    borderTop: line,
    borderRight: line,
    borderBottom: line,
    borderLeft: line,
    background: active ? "var(--hairline)" : "transparent",
    color: active ? "var(--text)" : "var(--text-dim)",
    whiteSpace: "nowrap",
  };
};

/**
 * One row: what the map is being asked.
 *
 * Current and the windows are peers, one row of mutually exclusive choices,
 * because they are alternative questions rather than modifiers of one another.
 * Pairing a window with a separate "show everything" toggle makes half the
 * combinations duplicates and implies the window means something it doesn't.
 */
export function WindowPicker({
  view,
  onView,
  emptyOnly,
  onEmptyOnly,
  pending,
  scrollable = false,
}: Props) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        ...(scrollable
          ? {
              overflowX: "auto",
              overflowY: "hidden",
              // The row is the full width of the header, and its own padding
              // keeps the first and last chip clear of the screen edge.
              padding: "0 12px",
              scrollbarWidth: "none",
              WebkitOverflowScrolling: "touch",
            }
          : null),
      }}
    >
      <div style={{ display: "flex", gap: 2, flexShrink: 0 }} role="group" aria-label="View">
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
              ...(v.key === "current"
                ? { borderRight: "1px solid var(--hairline-bright)", paddingRight: 12 }
                : null),
            }}
            title={v.title}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* A mode rather than another window, so it sits behind a rule. Choosing
          it swaps the bottom bar for the timelapse's own controls, which run on
          a date range the windows have no concept of. */}
      <span
        aria-hidden
        style={{ width: 1, alignSelf: "stretch", background: "var(--hairline)", flexShrink: 0 }}
      />
      <button
        className="eyebrow"
        onClick={() => onView("timelapse")}
        aria-pressed={view === "timelapse"}
        style={{ ...chip(view === "timelapse"), flexShrink: 0 }}
        title="Play the record day by day, with Most Active Zones and changes of hands"
      >
        Timelapse
      </button>

      {/* Empty zones are always on the map now, so this is not a "show them"
          switch - it is "show me *only* them". A zone with no bots is a real
          place, and the question worth a control is where the world is
          unclaimed, not whether the terrain is drawn. */}
      <button
        className="eyebrow"
        onClick={() => onEmptyOnly(!emptyOnly)}
        aria-pressed={emptyOnly}
        style={{ ...chip(emptyOnly), flexShrink: 0 }}
        title="Show only zones holding no bots, including the 1.09M never played"
      >
        Only empty
      </button>

      {pending && (
        <span className="eyebrow" aria-live="polite">
          Reading&hellip;
        </span>
      )}
    </div>
  );
}
