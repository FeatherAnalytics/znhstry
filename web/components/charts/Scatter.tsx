"use client";

/**
 * One dot per day: how wide that day's tightest concentration was, over time.
 *
 * **A scatter and not a line**, because there is no continuity between one day's
 * cluster and the next's - they are different places. A line would draw a
 * trajectory through unrelated points and invite reading a trend that does not
 * exist.
 *
 * The y axis is logarithmic. Diameters run from under a kilometre to the cutoff,
 * and the days worth looking at are the small ones, which a linear axis presses
 * flat against the floor.
 *
 * Size carries the cluster's zone count, which is the second half of §7.1's
 * ranking. Size, not hue: it is an ordered quantity and area reads as ordered
 * where a categorical palette does not. The largest are also labelled directly,
 * so the reader never has to infer a count from a radius.
 */

import { useMemo, useRef, useState } from "react";

import { MAZ_AMBER } from "./palette";

export interface Point {
  day: number;
  /** The y value. Logarithmic, so it must be positive. */
  km: number;
  /** Drives the mark's area. */
  count: number;
  label: string;
}

interface Props {
  points: Point[];
  title: string;
  subtitle?: string;
  labelOf: (day: number) => string;
  /** Points at or above this count get a direct label. */
  labelAt?: number;
  height?: number;
}

const PAD = { top: 12, right: 14, bottom: 30, left: 46 };

/** Radius in px for a cluster of `n` zones, by area rather than by radius. */
const radiusFor = (n: number): number => 2 + Math.sqrt(Math.max(0, n - 1)) * 2.4;

export function Scatter({
  points,
  title,
  subtitle,
  labelOf,
  labelAt = 5,
  height = 260,
}: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const width = 640;
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;

  const { dayMin, daySpan, loKm, hiKm } = useMemo(() => {
    let dayMin = Infinity;
    let dayMax = -Infinity;
    let loKm = Infinity;
    let hiKm = 0;
    for (const p of points) {
      if (p.day < dayMin) dayMin = p.day;
      if (p.day > dayMax) dayMax = p.day;
      if (p.km > 0 && p.km < loKm) loKm = p.km;
      if (p.km > hiKm) hiKm = p.km;
    }
    if (!points.length) return { dayMin: 0, daySpan: 1, loKm: 0.1, hiKm: 100 };
    // Clamped to a tenth of a kilometre: a pair of zones can sit metres apart
    // and one such day would otherwise stretch the whole axis to accommodate it.
    return {
      dayMin,
      daySpan: Math.max(1, dayMax - dayMin),
      loKm: Math.max(0.1, loKm),
      hiKm,
    };
  }, [points]);

  const logLo = Math.log10(loKm);
  const logHi = Math.log10(hiKm);
  const logSpan = Math.max(0.5, logHi - logLo);

  const xOf = (day: number) => PAD.left + ((day - dayMin) / daySpan) * plotWidth;
  const yOf = (km: number) =>
    PAD.top + plotHeight - ((Math.log10(Math.max(km, loKm)) - logLo) / logSpan) * plotHeight;

  // Decade rules only, and only those inside the range.
  const rules: number[] = [];
  for (let e = Math.floor(logLo); e <= Math.ceil(logHi); e++) {
    const value = 10 ** e;
    if (value >= loKm && value <= hiKm) rules.push(value);
  }

  const onMove = (event: React.MouseEvent) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || !points.length) return;
    const scale = width / box.width;
    const mx = (event.clientX - box.left) * scale;
    const my = (event.clientY - box.top) * (height / box.height);

    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dx = xOf(points[i].day) - mx;
      const dy = yOf(points[i].km) - my;
      const gap = dx * dx + dy * dy;
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    // Only within reach, so the readout does not name a dot nowhere near the
    // cursor on an empty stretch of the plot.
    setHover(bestGap <= 24 * 24 ? best : null);
  };

  const labelled = points.filter((p) => p.count >= labelAt);

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
        aria-label={`${title}. ${points.length} days.`}
      >
        {rules.map((km) => (
          <g key={km}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={yOf(km)}
              y2={yOf(km)}
              stroke="var(--hairline)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={yOf(km) + 3}
              textAnchor="end"
              fontSize={9}
              fill="var(--text-dim)"
              className="tabular"
            >
              {km < 1 ? `${km}` : `${km} km`}
            </text>
          </g>
        ))}

        {points.map((p, i) => (
          <circle
            key={`${p.day}-${i}`}
            cx={xOf(p.day)}
            cy={yOf(p.km)}
            r={radiusFor(p.count)}
            fill={MAZ_AMBER}
            fillOpacity={hover === null || hover === i ? 0.55 : 0.2}
            stroke={hover === i ? "var(--text)" : "none"}
            strokeWidth={1.5}
          />
        ))}

        {/* Direct labels on the tail, so the rare days are named on the chart
            rather than left for the reader to hover for. */}
        {labelled.map((p) => (
          <text
            key={`label-${p.day}`}
            x={xOf(p.day)}
            y={yOf(p.km) - radiusFor(p.count) - 4}
            fontSize={9}
            fill="var(--text)"
            textAnchor="middle"
            className="tabular"
          >
            {p.label}
          </text>
        ))}

        {points.length ? (
          <>
            <text x={PAD.left} y={height - 8} fontSize={9} fill="var(--text-dim)" className="tabular">
              {labelOf(dayMin)}
            </text>
            <text
              x={width - PAD.right}
              y={height - 8}
              fontSize={9}
              fill="var(--text-dim)"
              textAnchor="end"
              className="tabular"
            >
              {labelOf(dayMin + daySpan)}
            </text>
          </>
        ) : null}
      </svg>

      <div
        className="tabular"
        style={{ fontSize: 11, color: "var(--text-dim)", minHeight: 16, marginTop: 2 }}
      >
        {hover === null ? (
          `${points.length.toLocaleString()} days · dot area is the zone count`
        ) : (
          <span style={{ color: "var(--text)" }}>
            {labelOf(points[hover].day)}: {points[hover].count} zones across{" "}
            {points[hover].km < 10
              ? points[hover].km.toFixed(1)
              : Math.round(points[hover].km).toLocaleString()}{" "}
            km
          </span>
        )}
      </div>
    </figure>
  );
}
