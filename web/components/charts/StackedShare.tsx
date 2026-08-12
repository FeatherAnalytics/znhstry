"use client";

/**
 * Three shares of one whole, over time, as a 100% stacked area.
 *
 * **Stacked and not three lines**, because the three always sum to one and that
 * is the fact worth drawing: a band's thickness is its share, and the bands
 * cannot drift apart or cross in a way that means nothing. Three separate lines
 * of a constant-sum quantity invite reading each one's slope as independent when
 * it is not.
 *
 * **Never two y-scales, and never counts.** The game's overall activity moves by
 * orders of magnitude across the record, so a stacked *count* chart shows the
 * growth of the game and hides the composition entirely.
 *
 * Smoothed by a trailing mean by default. Daily MAZ shares come from ten reports
 * against a world of 2.68M zones, so the raw series is mostly sampling noise and
 * a stacked area of it is three ribbons of static. The window is stated on the
 * chart rather than left implicit.
 */

import { useMemo, useRef, useState } from "react";

export interface Band {
  label: string;
  color: string;
  value: ArrayLike<number>;
}

interface Props {
  day: ArrayLike<number>;
  bands: Band[];
  title: string;
  subtitle?: string;
  labelOf: (day: number) => string;
  /** Trailing window in samples. 0 draws the raw series. */
  smooth?: number;
  height?: number;
}

const PAD = { top: 10, right: 12, bottom: 26, left: 40 };

/** A trailing mean over `window` samples, holding the leading edge steady. */
function smoothed(values: ArrayLike<number>, window: number): Float64Array {
  const out = new Float64Array(values.length);
  if (window <= 1) {
    for (let i = 0; i < values.length; i++) out[i] = values[i];
    return out;
  }
  let running = 0;
  for (let i = 0; i < values.length; i++) {
    running += values[i];
    if (i >= window) running -= values[i - window];
    out[i] = running / Math.min(i + 1, window);
  }
  return out;
}

export function StackedShare({
  day,
  bands,
  title,
  subtitle,
  labelOf,
  smooth = 30,
  height = 220,
}: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const width = 640;
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;
  const n = day.length;

  const { series, paths, dayMin, daySpan } = useMemo(() => {
    // Smooth first, then renormalise. The trailing mean is taken per band, and
    // three independent means of three shares do not have to add back to one -
    // left alone, that drift shows as a ragged top edge and reads as a fourth
    // category the data does not have.
    const raw = bands.map((b) => smoothed(b.value, smooth));
    const series = raw.map(() => new Float64Array(n));
    for (let i = 0; i < n; i++) {
      let total = 0;
      for (const values of raw) total += values[i];
      for (let b = 0; b < raw.length; b++) {
        series[b][i] = total > 0 ? raw[b][i] / total : 0;
      }
    }

    const dayMin = n ? day[0] : 0;
    const daySpan = Math.max(1, (n ? day[n - 1] : 1) - dayMin);

    const x = (i: number) => PAD.left + ((day[i] - dayMin) / daySpan) * plotWidth;
    const y = (v: number) => PAD.top + plotHeight - v * plotHeight;

    // Cumulative from the baseline up, so each band is the ribbon between its
    // own running total and the one below it.
    const below = new Float64Array(n);
    const paths: string[] = [];

    for (const values of series) {
      const top = new Float64Array(n);
      for (let i = 0; i < n; i++) top[i] = below[i] + values[i];

      let forward = "";
      let back = "";
      for (let i = 0; i < n; i++) {
        forward += `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(top[i]).toFixed(1)}`;
      }
      for (let i = n - 1; i >= 0; i--) {
        back += `L${x(i).toFixed(1)} ${y(below[i]).toFixed(1)}`;
      }
      paths.push(`${forward}${back}Z`);
      below.set(top);
    }

    return { series, paths, dayMin, daySpan };
  }, [day, bands, n, plotWidth, plotHeight, smooth]);

  const xOf = (i: number) => PAD.left + ((day[i] - dayMin) / daySpan) * plotWidth;

  const onMove = (event: React.MouseEvent) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || !n) return;
    const fraction = ((event.clientX - box.left) / box.width) * width;
    const target = dayMin + ((fraction - PAD.left) / plotWidth) * daySpan;

    let best = 0;
    let bestGap = Infinity;
    for (let i = 0; i < n; i++) {
      const gap = Math.abs(day[i] - target);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    setHover(best);
  };

  const at = hover ?? n - 1;
  const total = series.reduce((sum, s) => sum + (s[at] ?? 0), 0) || 1;

  return (
    <figure style={{ margin: 0 }}>
      <figcaption style={{ marginBottom: 6 }}>
        <div className="display" style={{ fontSize: 13 }}>
          {title}
        </div>
        {subtitle ? (
          <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 2 }}>{subtitle}</div>
        ) : null}
      </figcaption>

      <svg
        ref={svg}
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "auto", overflow: "visible" }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={title}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={PAD.top + plotHeight - f * plotHeight}
              y2={PAD.top + plotHeight - f * plotHeight}
              stroke="var(--hairline)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={PAD.top + plotHeight - f * plotHeight + 3}
              textAnchor="end"
              fontSize={9}
              fill="var(--text-dim)"
              className="tabular"
            >
              {Math.round(f * 100)}%
            </text>
          </g>
        ))}

        {/* A 2px surface gap between neighbouring fills, so the boundary between
            two saturated bands is a hairline of the surface rather than a seam
            where the two colours touch and vibrate. */}
        {paths.map((d, i) => (
          <path
            key={bands[i].label}
            d={d}
            fill={bands[i].color}
            stroke="var(--ink-raised)"
            strokeWidth={2}
            opacity={0.92}
          />
        ))}

        {hover !== null ? (
          <line
            x1={xOf(hover)}
            x2={xOf(hover)}
            y1={PAD.top}
            y2={PAD.top + plotHeight}
            stroke="var(--text)"
            strokeWidth={1}
            opacity={0.5}
          />
        ) : null}

        {n ? (
          <>
            <text x={PAD.left} y={height - 8} fontSize={9} fill="var(--text-dim)" className="tabular">
              {labelOf(day[0])}
            </text>
            <text
              x={width - PAD.right}
              y={height - 8}
              fontSize={9}
              fill="var(--text-dim)"
              textAnchor="end"
              className="tabular"
            >
              {labelOf(day[n - 1])}
            </text>
          </>
        ) : null}
      </svg>

      {/* Always present for three series, and direct-labelled with the value at
          the cursor: the faction hues clear the CVD floor by a hair, so identity
          never rests on colour alone. Text stays in ink tokens; the swatch
          carries the colour. */}
      <div
        className="tabular"
        style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, marginTop: 6 }}
      >
        <span style={{ color: "var(--text-dim)" }}>
          {hover === null ? "latest" : labelOf(day[hover])}
        </span>
        {bands.map((b, i) => (
          <span key={b.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span
              style={{
                width: 9,
                height: 9,
                background: b.color,
                borderRadius: 2,
                flexShrink: 0,
              }}
            />
            <span style={{ color: "var(--text-dim)" }}>{b.label}</span>
            <span style={{ color: "var(--text)" }}>
              {(((series[i][at] ?? 0) / total) * 100).toFixed(1)}%
            </span>
          </span>
        ))}
      </div>
    </figure>
  );
}
