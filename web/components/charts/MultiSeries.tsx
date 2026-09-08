"use client";

import { useMemo, useRef, useState } from "react";

export interface Series {
  label: string;
  color: string;
  values: (number | null)[];
}

interface Props {
  x: number[];
  series: Series[];
  title: string;
  subtitle?: string;
  labelOf: (x: number) => string;
  height?: number;
  unit?: string;
}

const PAD = { top: 10, right: 12, bottom: 26, left: 52 };

const compact = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`
      : `${Math.round(n)}`;

export function MultiSeries(props: Props) {
  const { x, series, title, subtitle, labelOf, height = 200, unit = "" } = props;
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const width = 640;
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;
  const n = x.length;

  const { top, xMin, xSpan, paths } = useMemo(() => {
    let top = 1;
    for (const s of series) {
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (v !== null && v > top) top = v;
      }
    }
    const xMin = n ? x[0] : 0;
    const xSpan = Math.max(1, (n ? x[n - 1] : 1) - xMin);

    const px = (i: number) => PAD.left + ((x[i] - xMin) / xSpan) * plotWidth;
    const py = (v: number) => PAD.top + plotHeight - (v / top) * plotHeight;

    const paths = series.map((s) => {
      let d = "";
      let drawing = false;
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (v === null) {
          drawing = false;
          continue;
        }
        d += `${drawing ? "L" : "M"}${px(i).toFixed(1)} ${py(v).toFixed(1)}`;
        drawing = true;
      }
      return d;
    });

    return { top, xMin, xSpan, paths };
  }, [x, series, n, plotWidth, plotHeight]);

  const onMove = (event: React.MouseEvent) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || !n) return;
    const fraction = ((event.clientX - box.left) / box.width) * width;
    const target = xMin + ((fraction - PAD.left) / plotWidth) * xSpan;

    let best = 0;
    let bestGap = Infinity;
    for (let i = 0; i < n; i++) {
      const gap = Math.abs(x[i] - target);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    setHover(best);
  };

  const xOf = (i: number) => PAD.left + ((x[i] - xMin) / xSpan) * plotWidth;
  const yOf = (v: number) => PAD.top + plotHeight - (v / top) * plotHeight;
  const ticks = [0, 0.5, 1].map((f) => top * f);

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
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={yOf(t)}
              y2={yOf(t)}
              stroke="var(--hairline)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={yOf(t) + 3}
              textAnchor="end"
              fontSize={9}
              fill="var(--text-dim)"
              className="tabular"
            >
              {compact(t)}
            </text>
          </g>
        ))}

        {paths.map((d, i) =>
          d ? (
            <path
              key={series[i].label}
              d={d}
              fill="none"
              stroke={series[i].color}
              strokeWidth={2}
              strokeLinejoin="round"
            />
          ) : null,
        )}

        {hover !== null ? (
          <g>
            <line
              x1={xOf(hover)}
              x2={xOf(hover)}
              y1={PAD.top}
              y2={PAD.top + plotHeight}
              stroke="var(--text)"
              strokeWidth={1}
              opacity={0.4}
            />
            {series.map((s) => {
              const v = s.values[hover];
              if (v === null) return null;
              return (
                <circle
                  key={s.label}
                  cx={xOf(hover)}
                  cy={yOf(v)}
                  r={4}
                  fill={s.color}
                  stroke="var(--ink-raised)"
                  strokeWidth={2}
                />
              );
            })}
          </g>
        ) : null}

        {n ? (
          <>
            <text x={PAD.left} y={height - 8} fontSize={9} fill="var(--text-dim)" className="tabular">
              {labelOf(x[0])}
            </text>
            <text
              x={width - PAD.right}
              y={height - 8}
              fontSize={9}
              fill="var(--text-dim)"
              textAnchor="end"
              className="tabular"
            >
              {labelOf(x[n - 1])}
            </text>
          </>
        ) : null}
      </svg>

      <div
        className="tabular"
        style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, marginTop: 6 }}
      >
        <span style={{ color: "var(--text-dim)" }}>
          {hover === null ? "latest" : labelOf(x[hover])}
        </span>
        {series.map((s) => {
          const v = hover !== null ? s.values[hover] : s.values[n - 1];
          return (
            <span key={s.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span
                style={{ width: 9, height: 9, background: s.color, borderRadius: 2, flexShrink: 0 }}
              />
              <span style={{ color: "var(--text-dim)" }}>{s.label}</span>
              <span style={{ color: "var(--text)" }}>
                {v !== null ? `${compact(v)}${unit}` : "—"}
              </span>
            </span>
          );
        })}
      </div>
    </figure>
  );
}
