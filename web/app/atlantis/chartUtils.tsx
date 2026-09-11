import { useState, useEffect, type RefObject } from "react";

export function useWidth(ref: RefObject<HTMLDivElement | null>, initial = 800): number {
  const [w, setW] = useState(initial);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    setW(ref.current.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export function YearLabels(props: { months: string[]; maxBarW?: number; gap?: number }) {
  let firstLabeled = false;
  const marginGap = props.gap ?? 6;
  return (
    <div style={{ display: "flex", gap: 1 }}>
      {props.months.map((m, i) => {
        const isJan = m.endsWith("-01");
        const show = isJan || (!firstLabeled && i === 0);
        if (show) firstLabeled = true;
        return (
          <div key={m} style={{ flex: "1 1 0", maxWidth: props.maxBarW, marginLeft: isJan ? marginGap : 0, minWidth: 0 }}>
            {show ? <span className="tabular" style={{ fontSize: 7, color: "var(--text-dim)" }}>{m.slice(0, 4)}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
