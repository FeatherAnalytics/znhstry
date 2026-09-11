import { useState, useCallback, useRef, type PointerEvent } from "react";

export interface HoverState {
  index: number;
  x: number;
}

export function useChartHover(n: number, step: number) {
  const [hover, setHover] = useState<HoverState | null>(null);

  const onPointerMove = useCallback(
    (e: PointerEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const idx = Math.round(x / step);
      if (idx >= 0 && idx < n) setHover({ index: idx, x: idx * step });
    },
    [n, step],
  );

  const onPointerLeave = useCallback(() => setHover(null), []);

  return { hover, onPointerMove, onPointerLeave };
}

export function useBarHover(n: number) {
  const [index, setIndex] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!ref.current) return;
      const cx = e.clientX;
      const children = ref.current.children;
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < children.length && i < n; i++) {
        const r = (children[i] as HTMLElement).getBoundingClientRect();
        if (cx >= r.left && cx <= r.right) { best = i; break; }
        const dist = Math.min(Math.abs(cx - r.left), Math.abs(cx - r.right));
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
      setIndex(best >= 0 ? best : null);
    },
    [n],
  );

  const onPointerLeave = useCallback(() => setIndex(null), []);

  return { index, ref, onPointerMove, onPointerLeave };
}
