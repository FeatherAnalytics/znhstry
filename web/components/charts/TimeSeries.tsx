"use client";

/**
 * One measure over the record, as a line with a crosshair.
 *
 * **One measure per chart, never two y-scales.** Launches and players are on
 * different scales and putting them on one plot with two axes lets the reader
 * see any correlation the axis ranges are chosen to produce. Two charts stacked
 * share an x axis and say the same thing honestly.
 *
 * Daily MAZ totals are noisy - the top ten is a small sample of a big world - so
 * a trailing mean is drawn over the raw series rather than instead of it. The
 * raw points stay visible at low opacity, because smoothing away the spikes
 * would hide exactly the rare days worth looking at.
 */

import { useMemo, useRef, useState } from "react";

const MAZ_AMBER = "#ffc857";

interface Props {
  day: ArrayLike<number>;
  value: ArrayLike<number>;
  title: string;
  subtitle?: string;
  /** Turns a day number into a label for the axis and the tooltip. */
  labelOf: (day: number) => string;
  /** Trailing window for the smoothed line, in samples. 0 draws none. */
  smooth?: number;
  height?: number;
}

const PAD = { top: 10, right: 12, bottom: 26, left: 52 };

const compact = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`
      : `${Math.round(n)}`;

export function TimeSeries({
  day,
  value,
  title,
  subtitle,
  labelOf,
  smooth = 30,
  height = 200,
}: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const width = 640;
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;
  const n = value.length;

  const { top, dayMin, daySpan, rawPath, smoothPath } = useMemo(() => {
    let top = 1;
    for (let i = 0; i < n; i++) if (value[i] > top) top = value[i];
    const dayMin = n ? day[0] : 0;
    const daySpan = Math.max(1, (n ? day[n - 1] : 1) - dayMin);

    const x = (i: number) => PAD.left + ((day[i] - dayMin) / daySpan) * plotWidth;
    const y = (v: number) => PAD.top + plotHeight - (v / top) * plotHeight;

    let rawPath = "";
    for (let i = 0; i < n; i++) rawPath += `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(value[i]).toFixed(1)}`;

    let smoothPath = "";
    if (smooth > 1 && n > smooth) {
      // Running sum rather than a window per point: 4,599 samples either way,
      // but this stays linear if the series ever gets finer than a day.
      let running = 0;
      for (let i = 0; i < n; i++) {
        running += value[i];
        if (i >= smooth) running -= value[i - smooth];
        if (i < smooth - 1) continue;
        const mean = running / smooth;
        smoothPath += `${smoothPath ? "L" : "M"}${x(i).toFixed(1)} ${y(mean).toFixed(1)}`;
      }
    }
    return { top, dayMin, daySpan, rawPath, smoothPath };
  }, [day, value, n, plotWidth, plotHeight, smooth]);

  const onMove = (event: React.MouseEvent) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || !n) return;
    const fraction = ((event.clientX - box.left) / box.width) * width;
    const target = dayMin + ((fraction - PAD.left) / plotWidth) * daySpan;

    // Nearest sample by day, not by index: the series skips days with no
    // reports, so index arithmetic drifts against the axis.
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

  const xOf = (i: number) => PAD.left + ((day[i] - dayMin) / daySpan) * plotWidth;
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

        <path d={rawPath} fill="none" stroke={MAZ_AMBER} strokeWidth={1} opacity={0.28} />
        {smoothPath ? (
          <path
            d={smoothPath}
            fill="none"
            stroke={MAZ_AMBER}
            strokeWidth={2}
            strokeLinejoin="round"
          />
        ) : null}

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
            {/* A surface ring, so the marker reads against the line under it. */}
            <circle
              cx={xOf(hover)}
              cy={yOf(value[hover])}
              r={4}
              fill={MAZ_AMBER}
              stroke="var(--ink-raised)"
              strokeWidth={2}
            />
          </g>
        ) : null}

        {n ? (
          <>
            <text
              x={PAD.left}
              y={height - 8}
              fontSize={9}
              fill="var(--text-dim)"
              className="tabular"
            >
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

      <div
        className="tabular"
        style={{ fontSize: 11, color: "var(--text-dim)", minHeight: 16, marginTop: 2 }}
      >
        {hover === null ? (
          smooth > 1 ? (
            `daily, with a ${smooth}-sample trailing mean`
          ) : (
            "daily"
          )
        ) : (
          <span style={{ color: "var(--text)" }}>
            {labelOf(day[hover])}: {Math.round(value[hover]).toLocaleString()}
          </span>
        )}
      </div>
    </figure>
  );
}
