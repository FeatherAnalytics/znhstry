"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

export interface SeriesPoint {
  day: number;
  legion: number;
  swarm: number;
  faceless: number;
}

interface Props {
  series: SeriesPoint[];
  day: number;
  minDay: number;
  maxDay: number;
  onScrub: (day: number) => void;
  epoch: string;
  gapYear?: number;
}

/**
 * The signature element: the timeline is the history.
 *
 * Each faction's band thickness is its share of bots, so dragging through
 * fourteen years happens against a picture of the whole war. The thin, faint
 * early years show the 2012-19 sparsity honestly instead of a linear slider
 * pretending those years are as dense as 2021 -- and the upstream collection
 * gap reads as a seam in the rock rather than a footnote.
 */
export function StrataScrubber({ series, day, minDay, maxDay, onScrub, epoch, gapYear }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const span = Math.max(1, maxDay - minDay);

  const ticks = useMemo(() => {
    const start = new Date(`${epoch}T00:00:00Z`);
    const years: { day: number; label: string }[] = [];
    for (let year = 2012; year <= 2027; year += 2) {
      const d = Math.floor((Date.UTC(year, 0, 1) - start.getTime()) / 86_400_000);
      if (d >= minDay && d <= maxDay) years.push({ day: d, label: String(year) });
    }
    return years;
  }, [epoch, minDay, maxDay]);

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

    const styles = getComputedStyle(document.documentElement);
    const colors = ["--legion", "--swarm", "--faceless"].map((v) =>
      styles.getPropertyValue(v).trim(),
    );

    const peak = series.reduce((m, p) => Math.max(m, p.legion + p.swarm + p.faceless), 1);
    const x = (d: number) => ((d - minDay) / span) * width;

    // Stacked areas, drawn bottom-up so the bands read as strata.
    const bands: (keyof SeriesPoint)[] = ["legion", "swarm", "faceless"];
    const baseline = new Float64Array(series.length);

    bands.forEach((band, bandIndex) => {
      ctx.beginPath();
      for (let i = 0; i < series.length; i++) {
        const value = series[i][band] as number;
        const y = height - ((baseline[i] + value) / peak) * height;
        i === 0 ? ctx.moveTo(x(series[i].day), y) : ctx.lineTo(x(series[i].day), y);
      }
      for (let i = series.length - 1; i >= 0; i--) {
        ctx.lineTo(x(series[i].day), height - (baseline[i] / peak) * height);
      }
      ctx.closePath();
      ctx.fillStyle = colors[bandIndex];
      ctx.globalAlpha = 0.82;
      ctx.fill();
      for (let i = 0; i < series.length; i++) baseline[i] += series[i][band] as number;
    });

    ctx.globalAlpha = 1;

    if (gapYear) {
      const start = new Date(`${epoch}T00:00:00Z`).getTime();
      const from = x(Math.floor((Date.UTC(gapYear, 0, 1) - start) / 86_400_000));
      const to = x(Math.floor((Date.UTC(gapYear + 1, 0, 1) - start) / 86_400_000));
      ctx.fillStyle = "rgba(7,9,14,0.55)";
      ctx.fillRect(from, 0, to - from, height);
      ctx.strokeStyle = "rgba(230,234,242,0.28)";
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(from, 0);
      ctx.lineTo(from, height);
      ctx.moveTo(to, 0);
      ctx.lineTo(to, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [series, minDay, span, epoch, gapYear]);

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
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
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

  const position = ((day - minDay) / span) * 100;

  return (
    <div style={{ borderTop: "1px solid var(--hairline)", background: "var(--ink)" }}>
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
        style={{ position: "relative", height: 86, cursor: "ew-resize", touchAction: "none" }}
      >
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: `${position}%`,
            width: 1,
            background: "var(--text)",
            boxShadow: "0 0 0 1px rgba(7,9,14,0.9)",
            pointerEvents: "none",
          }}
        />
      </div>
      <div
        className="eyebrow tabular"
        style={{
          position: "relative",
          height: 22,
          borderTop: "1px solid var(--hairline)",
        }}
      >
        {ticks.map((tick) => (
          <span
            key={tick.label}
            style={{
              position: "absolute",
              left: `${((tick.day - minDay) / span) * 100}%`,
              transform: "translateX(-50%)",
              top: 5,
            }}
          >
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}
