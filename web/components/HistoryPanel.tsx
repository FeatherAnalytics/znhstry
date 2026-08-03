"use client";

import { useCallback, useEffect, useRef } from "react";
import type { HistorySeries } from "@/lib/history";
import { dayToDate } from "@/lib/data";

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
  epoch: string;
  title: string;
  subtitle: string;
  status: string | null;
  onClose?: () => void;
}

function compact(value: number): string {
  const sign = value < 0 ? "-" : "";
  const v = Math.abs(value);
  if (v >= 1e9) return `${sign}${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${sign}${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${sign}${(v / 1e3).toFixed(0)}K`;
  return `${sign}${Math.round(v)}`;
}

export function HistoryPanel({
  series,
  mode,
  onModeChange,
  range,
  onRangeChange,
  day,
  epoch,
  title,
  subtitle,
  status,
  onClose,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

    const window_ = RANGES.find((r) => r.key === range)!.days;
    const lo = Math.max(0, window_ === Infinity ? 0 : day - window_);
    const hi = Math.min(series.days.length - 1, day);
    if (hi <= lo) return;

    const styles = getComputedStyle(document.documentElement);
    const colors = ["--legion", "--swarm", "--faceless"].map((v) =>
      styles.getPropertyValue(v).trim(),
    );
    const bands = [series.legion, series.swarm, series.faceless];

    let peak = 1;
    for (let d = lo; d <= hi; d++) peak = Math.max(peak, bands[0][d] + bands[1][d] + bands[2][d]);

    const x = (d: number) => ((d - lo) / (hi - lo)) * width;
    const baseline = new Float64Array(hi - lo + 1);

    bands.forEach((band, i) => {
      ctx.beginPath();
      for (let d = lo; d <= hi; d++) {
        const y = height - ((baseline[d - lo] + band[d]) / peak) * height;
        d === lo ? ctx.moveTo(x(d), y) : ctx.lineTo(x(d), y);
      }
      for (let d = hi; d >= lo; d--) {
        ctx.lineTo(x(d), height - (baseline[d - lo] / peak) * height);
      }
      ctx.closePath();
      ctx.fillStyle = colors[i];
      ctx.globalAlpha = 0.8;
      ctx.fill();
      for (let d = lo; d <= hi; d++) baseline[d - lo] += band[d];
    });

    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(230,234,242,0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(hi) - 0.5, 0);
    ctx.lineTo(x(hi) - 0.5, height);
    ctx.stroke();
  }, [series, range, day]);

  useEffect(() => {
    draw();
    const observer = new ResizeObserver(draw);
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [draw]);

  const at = series && day < series.days.length ? day : null;
  const total =
    at === null || !series ? 0 : series.legion[at] + series.swarm[at] + series.faceless[at];

  const window_ = RANGES.find((r) => r.key === range)!.days;
  const from = series
    ? dayToDate(epoch, Math.max(0, window_ === Infinity ? 0 : day - window_))
    : null;
  const change =
    series && at !== null && from
      ? (() => {
          const start = Math.max(0, window_ === Infinity ? 0 : day - window_);
          const before = series.legion[start] + series.swarm[start] + series.faceless[start];
          return before > 0 ? ((total - before) / before) * 100 : null;
        })()
      : null;

  return (
    <section
      style={{
        position: "absolute",
        left: 16,
        bottom: 16,
        width: 340,
        padding: "14px 16px 12px",
        background: "rgba(14,18,24,0.82)",
        backdropFilter: "var(--panel-blur)",
        WebkitBackdropFilter: "var(--panel-blur)",
        border: "1px solid var(--hairline-bright)",
        zIndex: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="eyebrow" style={{ flex: 1 }}>
          {title}
        </span>
        {onClose && mode === "zone" && (
          <button className="eyebrow" onClick={onClose} aria-label="Clear zone selection">
            Clear
          </button>
        )}
      </div>

      <div
        className="display tabular"
        style={{ fontSize: 22, lineHeight: 1.15, margin: "4px 0 1px" }}
      >
        {compact(total)}
      </div>
      <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
        {subtitle}
        {change !== null && (
          <>
            {" · "}
            {change > 0 ? "+" : ""}
            {change.toFixed(1)}% over {RANGES.find((r) => r.key === range)!.label.toLowerCase()}
          </>
        )}
      </div>

      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: 78, display: "block", margin: "10px 0 8px" }}
      />

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ display: "flex", gap: 2 }} role="group" aria-label="Series">
          {(["scope", "viewport"] as const).map((m) => (
            <button
              key={m}
              className="eyebrow"
              onClick={() => onModeChange(m)}
              aria-pressed={mode === m}
              style={{
                padding: "2px 7px",
                color: mode === m ? "var(--text)" : "var(--text-dim)",
                border: `1px solid ${mode === m ? "var(--hairline-bright)" : "transparent"}`,
              }}
            >
              {m === "scope" ? "All" : "Viewport"}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 2, marginLeft: "auto" }} role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r.key}
              className="eyebrow"
              onClick={() => onRangeChange(r.key)}
              aria-pressed={range === r.key}
              style={{
                padding: "2px 6px",
                color: range === r.key ? "var(--text)" : "var(--text-dim)",
                border: `1px solid ${range === r.key ? "var(--hairline-bright)" : "transparent"}`,
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {status && (
        <div className="eyebrow" style={{ marginTop: 8 }} role="status">
          {status}
        </div>
      )}
    </section>
  );
}
