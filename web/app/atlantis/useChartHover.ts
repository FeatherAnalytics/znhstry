import { useState, useCallback, useRef, type MouseEvent } from "react";

export interface HoverState {
  index: number;
  x: number;
}

export function useChartHover(n: number, step: number) {
  const [hover, setHover] = useState<HoverState | null>(null);

  const onMouseMove = useCallback(
    (e: MouseEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const idx = Math.round(x / step);
      if (idx >= 0 && idx < n) setHover({ index: idx, x: idx * step });
    },
    [n, step],
  );

  const onMouseLeave = useCallback(() => setHover(null), []);

  return { hover, onMouseMove, onMouseLeave };
}

export function useBarHover(n: number) {
  const [index, setIndex] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const onMouseMove = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const idx = Math.floor(((e.clientX - rect.left) / rect.width) * n);
      setIndex(idx >= 0 && idx < n ? idx : null);
    },
    [n],
  );

  const onMouseLeave = useCallback(() => setIndex(null), []);

  return { index, ref, onMouseMove, onMouseLeave };
}
