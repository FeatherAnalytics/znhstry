"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type SheetStop = "peek" | "half" | "full";

/**
 * The map is the page; this sits over it.
 *
 * Three stops rather than free dragging, because the useful heights are
 * discrete: a summary line, the faction breakdown, and the chart. Free
 * positioning would let a reader park it somewhere that shows half a chart.
 *
 * Heights are fractions of the viewport, so the sheet is the same shape on a
 * small phone and a large one, and `peek` always leaves the map dominant.
 */
const STOPS: Record<SheetStop, number> = { peek: 0.14, half: 0.46, full: 0.82 };

const ORDER: SheetStop[] = ["peek", "half", "full"];

interface Props {
  stop: SheetStop;
  onStop: (stop: SheetStop) => void;
  /** Always visible, at every stop. One line. */
  summary: ReactNode;
  children: ReactNode;
}

export function BottomSheet({ stop, onStop, summary, children }: Props) {
  const [height, setHeight] = useState(() => STOPS[stop]);
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  // Follow the prop whenever a drag is not overriding it.
  useEffect(() => {
    if (!dragging) setHeight(STOPS[stop]);
  }, [stop, dragging]);

  const end = useCallback(
    (fraction: number) => {
      // Snap to whichever stop the sheet was left nearest.
      let nearest = ORDER[0];
      for (const candidate of ORDER) {
        if (Math.abs(STOPS[candidate] - fraction) < Math.abs(STOPS[nearest] - fraction)) {
          nearest = candidate;
        }
      }
      setDragging(false);
      setHeight(STOPS[nearest]);
      onStop(nearest);
    },
    [onStop],
  );

  const onPointerDown = (event: React.PointerEvent) => {
    // Only the handle starts a drag; the body needs to scroll.
    (event.target as Element).setPointerCapture?.(event.pointerId);
    startY.current = event.clientY;
    startHeight.current = height;
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!dragging) return;
    const delta = (startY.current - event.clientY) / window.innerHeight;
    setHeight(Math.min(STOPS.full, Math.max(STOPS.peek, startHeight.current + delta)));
  };

  const onPointerUp = () => dragging && end(height);

  const cycle = () => onStop(ORDER[(ORDER.indexOf(stop) + 1) % ORDER.length]);

  return (
    <section
      aria-label="Details"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: `${height * 100}%`,
        display: "flex",
        flexDirection: "column",
        background: "rgba(10,13,19,0.94)",
        backdropFilter: "var(--panel-blur)",
        WebkitBackdropFilter: "var(--panel-blur)",
        borderTop: "1px solid var(--hairline-bright)",
        zIndex: 20,
        transition: dragging ? "none" : "height 180ms ease-out",
      }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          padding: "0 16px 6px",
          cursor: "grab",
          flexShrink: 0,
          touchAction: "none",
        }}
      >
        <button
          onClick={cycle}
          aria-label={`Details panel, ${stop}. Activate to expand.`}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 48,
            height: 44,
            margin: "0 auto",
            border: "none",
            padding: 0,
            background: "transparent",
            cursor: "pointer",
          }}
        >
          <span
            style={{
              display: "block",
              width: 40,
              height: 4,
              borderRadius: 2,
              background: "var(--text-dim)",
              opacity: 0.6,
            }}
          />
        </button>
        {summary}
      </div>

      {(stop !== "peek" || dragging) && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            overscrollBehavior: "contain",
            touchAction: "pan-y",
          }}
        >
          {children}
        </div>
      )}
    </section>
  );
}
