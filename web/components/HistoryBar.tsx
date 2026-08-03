"use client";

import { useCallback, useEffect, useRef } from "react";
import { dayToDate } from "@/lib/data";
import type { HistorySeries } from "@/lib/history";

export type HistoryMode = "scope" | "viewport" | "zone";

export const RANGES = [
  { key: "all", label: "All", days: Infinity },
  { key: "5y", label: "5Y", days: 1826 },
  { key: "1y", label: "1Y", days: 365 },
  { key: "90d", label: "90D", days: 90 },
] as const;

export type RangeKey = (typeof RANGES)[number]["key"];

interface Props {
  series: HistorySeries | null;
  mode: HistoryMode;
  onModeChange: (mode: HistoryMode) => void;
  range: RangeKey;
  onRangeChange: (range: RangeKey) => void;
  day: number;
  minDay: number;
  maxDay: number;
  onScrub: (day: number) => void;
  epoch: string;
  title: string;
  subtitle: string;
  status: string | null;
  onClearZone?: () => void;
  gapYear?: number;
}

const CHART_HEIGHT = 104;
const Y_GUTTER = 52;

function compact(value: number): string {
  const sign = value < 0 ? "-" : "";
  const v = Math.abs(value);
  if (v >= 1e9) return `${sign}${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${sign}${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${sign}${(v / 1e3).toFixed(0)}K`;
  return `${sign}${Math.round(v)}`;
}

/** Largest of 1/2/5 x 10^n at or below the ideal spacing. */
function niceStep(peak: number, target: number): number {
  const rough = peak / target;
  if (rough <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  let best = magnitude;
  for (const m of [1, 2, 5, 10]) if (magnitude * m <= rough) best = magnitude * m;
  return best;
}

/**
 * One chart, doing two jobs.
 *
 * It plots the selected series across the whole record and is also the date
 * control. Having a separate overview strip and detail chart meant two stacked
 * area charts of the same data, which read as a puzzle rather than a reading.
 * The range filter shades the unselected span instead of zooming, so the
 * fourteen-year shape stays navigable at every range.
 */
export function HistoryBar({
  series,
  mode,
  onModeChange,
  range,
  onRangeChange,
  day,
  minDay,
  maxDay,
  onScrub,
  epoch,
  title,
  subtitle,
  status,
  onClearZone,
  gapYear,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const span = Math.max(1, maxDay - minDay);
  const windowDays = RANGES.find((r) => r.key === range)!.days;
  const windowStart = Math.max(minDay, windowDays === Infinity ? minDay : day - windowDays);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!series || !series.days.length) return;

    const plotWidth = Math.max(10, width - Y_GUTTER);
    const plotHeight = height;
    const x = (d: number) => ((d - minDay) / span) * plotWidth;

    const styles = getComputedStyle(document.documentElement);
    const colors = ["--legion", "--swarm", "--faceless"].map((v) =>
      styles.getPropertyValue(v).trim(),
    );
    const bands = [series.legion, series.swarm, series.faceless];

    const last = Math.min(series.days.length - 1, maxDay);
    let peak = 1;
    for (let d = minDay; d <= last; d++) peak = Math.max(peak, bands[0][d] + bands[1][d] + bands[2][d]);

    const baseline = new Float64Array(last - minDay + 1);
    bands.forEach((band, i) => {
      ctx.beginPath();
      for (let d = minDay; d <= last; d++) {
        const y = plotHeight - ((baseline[d - minDay] + band[d]) / peak) * plotHeight;
        d === minDay ? ctx.moveTo(x(d), y) : ctx.lineTo(x(d), y);
      }
      for (let d = last; d >= minDay; d--) {
        ctx.lineTo(x(d), plotHeight - (baseline[d - minDay] / peak) * plotHeight);
      }
      ctx.closePath();
      ctx.fillStyle = colors[i];
      ctx.globalAlpha = 0.82;
      ctx.fill();
      for (let d = minDay; d <= last; d++) baseline[d - minDay] += band[d];
    });
    ctx.globalAlpha = 1;

    // Range selection shades what is outside it rather than cropping.
    if (windowDays !== Infinity) {
      ctx.fillStyle = "rgba(7,9,14,0.62)";
      ctx.fillRect(0, 0, x(windowStart), plotHeight);
      if (day < maxDay) ctx.fillRect(x(day), 0, plotWidth - x(day), plotHeight);
    }

    // The upstream collection gap, marked so the dip does not read as history.
    if (gapYear) {
      const epochMs = new Date(`${epoch}T00:00:00Z`).getTime();
      const from = x(Math.floor((Date.UTC(gapYear, 0, 1) - epochMs) / 86_400_000));
      const to = x(Math.floor((Date.UTC(gapYear + 1, 0, 1) - epochMs) / 86_400_000));
      ctx.strokeStyle = "rgba(230,234,242,0.22)";
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(from, 0);
      ctx.lineTo(from, plotHeight);
      ctx.moveTo(to, 0);
      ctx.lineTo(to, plotHeight);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Y axis: round bot counts, labelled in the right gutter.
    ctx.font = '9px var(--font-mono), ui-monospace, monospace';
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const step = niceStep(peak, 3);
    for (let v = step; v <= peak * 1.001; v += step) {
      const y = Math.round(plotHeight - (v / peak) * plotHeight) + 0.5;
      ctx.strokeStyle = "rgba(230,234,242,0.10)";
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotWidth, y);
      ctx.stroke();
      ctx.fillStyle = "rgba(124,135,152,0.95)";
      ctx.fillText(compact(v), plotWidth + 5, y);
    }

    // Playhead.
    ctx.strokeStyle = "var(--text)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x(day)) + 0.5, 0);
    ctx.lineTo(Math.round(x(day)) + 0.5, plotHeight);
    ctx.stroke();
  }, [series, minDay, maxDay, span, day, windowDays, windowStart, epoch, gapYear]);

  useEffect(() => {
    draw();
    const observer = new ResizeObserver(draw);
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [draw]);

  const scrubFrom = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const plotWidth = Math.max(10, rect.width - Y_GUTTER);
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / plotWidth));
      onScrub(Math.round(minDay + ratio * span));
    },
    [minDay, span, onScrub],
  );

  useEffect(() => {
    const move = (e: PointerEvent) => dragging.current && scrubFrom(e.clientX);
    const up = () => (dragging.current = false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [scrubFrom]);

  const total =
    series && day < series.days.length
      ? series.legion[day] + series.swarm[day] + series.faceless[day]
      : 0;
  const before =
    series && windowStart < series.days.length
      ? series.legion[windowStart] + series.swarm[windowStart] + series.faceless[windowStart]
      : 0;
  const change = before > 0 ? ((total - before) / before) * 100 : null;

  const years: { day: number; label: string }[] = [];
  {
    const epochMs = new Date(`${epoch}T00:00:00Z`).getTime();
    const from = dayToDate(epoch, minDay).getUTCFullYear();
    const to = dayToDate(epoch, maxDay).getUTCFullYear();
    for (let y = from + 1; y <= to; y += span > 4000 ? 2 : 1) {
      years.push({
        day: Math.floor((Date.UTC(y, 0, 1) - epochMs) / 86_400_000),
        label: String(y),
      });
    }
  }

  const button = (active: boolean) => ({
    padding: "2px 7px",
    color: active ? "var(--text)" : "var(--text-dim)",
    border: `1px solid ${active ? "var(--hairline-bright)" : "transparent"}`,
  });

  return (
    <section
      style={{
        borderTop: "1px solid var(--hairline)",
        background: "var(--ink)",
        padding: "10px 18px 6px",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 6 }}>
        <span className="eyebrow">{title}</span>
        <span className="display tabular" style={{ fontSize: 19, lineHeight: 1 }}>
          {compact(total)}
        </span>
        <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
          {subtitle}
          {change !== null && (
            <>
              {" · "}
              {change > 0 ? "+" : ""}
              {change.toFixed(1)}% over{" "}
              {RANGES.find((r) => r.key === range)!.label.toLowerCase()}
            </>
          )}
        </span>

        <div style={{ display: "flex", gap: 2, marginLeft: "auto" }} role="group" aria-label="Series">
          {(["scope", "viewport"] as const).map((m) => (
            <button
              key={m}
              className="eyebrow"
              onClick={() => onModeChange(m)}
              aria-pressed={mode === m}
              style={button(mode === m)}
            >
              {m === "scope" ? "All zones" : "Viewport"}
            </button>
          ))}
          {mode === "zone" && onClearZone && (
            <button className="eyebrow" onClick={onClearZone} style={button(true)}>
              Clear zone
            </button>
          )}
        </div>
        <div style={{ display: "flex", gap: 2 }} role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r.key}
              className="eyebrow"
              onClick={() => onRangeChange(r.key)}
              aria-pressed={range === r.key}
              style={button(range === r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Date"
        aria-valuemin={minDay}
        aria-valuemax={maxDay}
        aria-valuenow={day}
        onPointerDown={(e) => {
          dragging.current = true;
          scrubFrom(e.clientX);
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 30 : 1;
          if (e.key === "ArrowLeft") onScrub(Math.max(minDay, day - step));
          if (e.key === "ArrowRight") onScrub(Math.min(maxDay, day + step));
        }}
        style={{ position: "relative", height: CHART_HEIGHT, cursor: "ew-resize", touchAction: "none" }}
      >
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
      </div>

      <div className="eyebrow tabular" style={{ position: "relative", height: 16, marginTop: 2 }}>
        {years.map((tick) => (
          <span
            key={tick.label}
            style={{
              position: "absolute",
              left: `calc(${((tick.day - minDay) / span) * 100}% - ${Y_GUTTER * ((tick.day - minDay) / span)}px)`,
              transform: "translateX(-50%)",
            }}
          >
            {tick.label}
          </span>
        ))}
        {status && <span style={{ position: "absolute", right: 0 }}>{status}</span>}
      </div>
    </section>
  );
}
