import { useEffect, useRef, type PointerEvent } from "react";

/**
 * Touch has no hover: a tap fires no pointermove, and lifting the finger fires
 * pointerleave. So a press selects as well, and a touch reading stays until the
 * next press outside the chart. `clear` must be a stable function.
 */
export function useChartPointer<E extends Element>(
  select: (event: PointerEvent<E>) => void,
  clear: () => void,
) {
  const chart = useRef<E | null>(null);

  useEffect(() => {
    const onDocumentPress = (event: globalThis.PointerEvent) => {
      if (event.pointerType === "touch" && !chart.current?.contains(event.target as Node)) clear();
    };
    document.addEventListener("pointerdown", onDocumentPress);
    return () => document.removeEventListener("pointerdown", onDocumentPress);
  }, [clear]);

  const onSelect = (event: PointerEvent<E>) => {
    chart.current = event.currentTarget;
    select(event);
  };

  return {
    className: "chart-scrub",
    onPointerDown: onSelect,
    onPointerMove: onSelect,
    onPointerLeave: (event: PointerEvent<E>) => {
      if (event.pointerType !== "touch") clear();
    },
    // The browser took the gesture as a scroll, so the press was not a selection.
    onPointerCancel: clear,
  };
}
