"use client";

/**
 * A log-binned histogram, in plain SVG.
 *
 * No chart library. The app already ships deck.gl and a hand-rolled scrubber,
 * and every chart here is one series of a few dozen bars - a library would be
 * more bytes than the whole page for layout logic that is two multiplications.
 *
 * **One series, so no legend and no categorical palette.** The bars wear the MAZ
 * amber the map uses for the same thing, which is the point: a ring on the map
 * and a bar in a chart mean the same event. Amber is deliberately none of the
 * three faction colors, so it never implies a faction fact.
 */

import { useState } from "react";
import type { Bin } from "@/lib/mazStats";

import { MAZ_AMBER } from "./palette";

interface Props {
  bins: Bin[];
  /** Names the single series, so the chart needs no legend box. */
  title: string;
  subtitle?: string;
  xLabel: string;
  /** Drawn as a dashed rule with a label. The median is worth more than a mean here. */
  markers?: { at: number; label: string }[];
  height?: number;
}

const PAD = { top: 8, right: 12, bottom: 34, left: 46 };

const compact = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`
      : `${Math.round(n)}`;

export function Histogram({ bins, title, subtitle, xLabel, markers = [], height = 200 }: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const width = 640;
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;

  const tallest = Math.max(1, ...bins.map((b) => b.count));
  // Bars sit on a log x axis, so a bin's width on screen is constant - the bins
  // are equal in log space by construction.
  const step = plotWidth / bins.length;
  const total = bins.reduce((n, b) => n + b.count, 0);

  // A marker's position has to use the same log mapping the bars do, or a
  // median rule lands next to the wrong bar and quietly contradicts the chart.
  const xOf = (value: number): number => {
    const b = bins.findIndex((bin) => value >= bin.lo && value < bin.hi);
    const index = b === -1 ? bins.length - 1 : b;
    return PAD.left + (index + 0.5) * step;
  };

  const ticks = [0, 0.5, 1].map((f) => Math.round(tallest * f));

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
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "auto", overflow: "visible" }}
        role="img"
        aria-label={`${title}. ${total} observations.`}
      >
        {ticks.map((t) => {
          const y = PAD.top + plotHeight - (t / tallest) * plotHeight;
          return (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y}
                y2={y}
                stroke="var(--hairline)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={y + 3}
                textAnchor="end"
                fontSize={9}
                fill="var(--text-dim)"
                className="tabular"
              >
                {compact(t)}
              </text>
            </g>
          );
        })}

        {bins.map((bin, i) => {
          const barHeight = (bin.count / tallest) * plotHeight;
          const x = PAD.left + i * step;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {/* A full-height target, so a one-pixel bar is still hoverable. */}
              <rect x={x} y={PAD.top} width={step} height={plotHeight} fill="transparent" />
              <rect
                x={x + 1}
                y={PAD.top + plotHeight - barHeight}
                width={Math.max(1, step - 2)}
                height={barHeight}
                rx={2}
                fill={MAZ_AMBER}
                opacity={hover === null || hover === i ? 1 : 0.45}
              />
            </g>
          );
        })}

        {markers.map((marker) => {
          const x = xOf(marker.at);
          return (
            <g key={marker.label}>
              <line
                x1={x}
                x2={x}
                y1={PAD.top}
                y2={PAD.top + plotHeight}
                stroke="var(--text)"
                strokeWidth={1}
                strokeDasharray="3 3"
                opacity={0.6}
              />
              <text x={x + 4} y={PAD.top + 10} fontSize={9} fill="var(--text)" opacity={0.8}>
                {marker.label}
              </text>
            </g>
          );
        })}

        {/* Decade ticks only. A label per bin is unreadable and says nothing a
            reader of a log axis does not already assume. */}
        {bins.map((bin, i) => {
          const decade = Math.log10(Math.max(1, bin.lo));
          if (bin.lo !== 0 && Math.abs(decade - Math.round(decade)) > 1e-6) return null;
          return (
            <text
              key={`tick-${i}`}
              x={PAD.left + i * step}
              y={height - PAD.bottom + 14}
              fontSize={9}
              fill="var(--text-dim)"
              textAnchor="middle"
              className="tabular"
            >
              {bin.lo === 0 ? "0" : compact(bin.lo)}
            </text>
          );
        })}

        <text
          x={PAD.left + plotWidth / 2}
          y={height - 4}
          fontSize={9}
          fill="var(--text-dim)"
          textAnchor="middle"
        >
          {xLabel}
        </text>
      </svg>

      <div
        className="tabular"
        style={{ fontSize: 11, color: "var(--text-dim)", minHeight: 16, marginTop: 2 }}
      >
        {hover === null ? (
          `${compact(total)} observations`
        ) : (
          <span style={{ color: "var(--text)" }}>
            {compact(bins[hover].lo)}–{compact(bins[hover].hi)} {xLabel}:{" "}
            {bins[hover].count.toLocaleString()} (
            {((bins[hover].count / total) * 100).toFixed(1)}%)
          </span>
        )}
      </div>
    </figure>
  );
}
