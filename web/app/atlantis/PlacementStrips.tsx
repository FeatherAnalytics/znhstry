import { useState, useCallback, useRef, type MouseEvent } from "react";
import { factionHex, isDerived, type AnyTournament } from "./lib";

function stripTitle(t: AnyTournament): string {
  const zones = t.placements.map(p => p[0] + ": " + p[1] + " zones").join("\n");
  const derived = isDerived(t) || ("is_derived_placements" in t && t.is_derived_placements);
  return t.month + (derived ? " (derived)" : "") + "\n" + zones;
}

function placeFaction(t: AnyTournament, place: number): string | null {
  return t.placements[place]?.[0] ?? null;
}

function stripColor(faction: string | null): string {
  return faction ? factionHex(faction) : "#333";
}

function yearGap(month: string): number {
  return month.endsWith("-01") ? 6 : 0;
}

export default function PlacementStrips(props: { tournaments: AnyTournament[] }) {
  const sorted = [...props.tournaments].sort((a, b) => a.month.localeCompare(b.month));
  const labels = ["1st", "2nd", "3rd"];
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const onMouseMove = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    const cx = e.clientX;
    const children = ref.current.children;
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < children.length && i < sorted.length; i++) {
      const r = (children[i] as HTMLElement).getBoundingClientRect();
      if (cx >= r.left && cx <= r.right) { best = i; break; }
      const dist = Math.min(Math.abs(cx - r.left), Math.abs(cx - r.right));
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    setHoverIdx(best >= 0 ? best : null);
  }, [sorted.length]);

  const onMouseLeave = useCallback(() => setHoverIdx(null), []);
  const hovered = hoverIdx != null ? sorted[hoverIdx] : null;

  return (
    <div style={{ marginBottom: 16 }} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}>
      {labels.map((label, place) => (
        <div key={label} style={{ display: "flex", alignItems: "center", marginBottom: place < 2 ? 4 : 0 }}>
          <span className="eyebrow" style={{ width: 24, flexShrink: 0, fontSize: 10 }}>{label}</span>
          <div ref={place === 0 ? ref : undefined} style={{ display: "flex", flex: 1, gap: 1, minWidth: 0, overflow: "hidden" }}>
            {sorted.map(t => (
              <div key={t.month} title={stripTitle(t)} style={{ flex: "1 1 0", height: 16, borderRadius: 1, minWidth: 0, background: stripColor(placeFaction(t, place)), marginLeft: yearGap(t.month) }} />
            ))}
          </div>
        </div>
      ))}
      <div style={{ display: "flex", paddingLeft: 24, gap: 1, overflow: "hidden" }}>
        {sorted.map(t => {
          const isYear = t.month.endsWith("-01");
          return (
            <div key={t.month} style={{ flex: "1 1 0", marginLeft: isYear ? 6 : 0 }}>
              {isYear ? <span className="tabular" style={{ fontSize: 9, color: "var(--text-dim)" }}>{t.month.slice(0, 4)}</span> : null}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2, minHeight: 16, paddingLeft: 24 }}>
        {hovered ? (
          <>
            <span style={{ fontWeight: 600 }}>{hovered.month}</span>
            {isDerived(hovered) ? <span style={{ marginLeft: 6, fontStyle: "italic" }}>derived</span> : null}
            {hovered.placements.map(p => (
              <span key={p[0]} style={{ marginLeft: 8, color: factionHex(p[0]) }}>{p[1]} zones</span>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}
