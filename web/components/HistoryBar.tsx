"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { dayToDate } from "@/lib/data";
import type { HistorySeries } from "@/lib/series";
import { windowDays, windowPhrase, type WindowKey } from "@/lib/windows";

/**
 * What the chart is counting.
 *
 * `scope` and `viewport` are chosen from the toggle. `zone` and `area` are
 * entered by clicking a dot or picking a country, and are left by clearing
 * them, so they are not offered as buttons.
 */
export type HistoryMode = "scope" | "viewport" | "zone" | "area";


interface Props {
  series: HistorySeries | null;
  mode: HistoryMode;
  onModeChange: (mode: HistoryMode) => void;
  span: WindowKey;
  onSpan: (span: WindowKey) => void;
  day: number;
  minDay: number;
  maxDay: number;
  onScrub: (day: number) => void;
  epoch: string;
  title: string;
  subtitle: string;
  status: string | null;
  onClearFocus?: () => void;
  gapYear?: number;
  playing?: boolean;
  onTogglePlay?: () => void;
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
  span,
  onSpan,
  day,
  minDay,
  maxDay,
  onScrub,
  epoch,
  title,
  subtitle,
  status,
  onClearFocus,
  gapYear,
  playing,
  onTogglePlay,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // Hovering reads a date; clicking commits it. There is no drag: the old
  // pointer-drag scrub needed an ew-resize cursor, which made a chart look
  // like a scrollbar.
  const [hoverDay, setHoverDay] = useState<number | null>(null);

  const visibleDays = windowDays(span);
  // The visible window ends at the playhead, so scrubbing back walks the
  // window with it. Selecting All restores whole-record navigation.
  const viewEnd = day;
  const viewStart = Math.max(minDay, visibleDays === Infinity ? minDay : day - visibleDays);
  // Days actually on the plot, which is the window clipped to the record.
  const plotDays = Math.max(1, viewEnd - viewStart);

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
    const x = (d: number) => ((d - viewStart) / plotDays) * plotWidth;

    const styles = getComputedStyle(document.documentElement);
    const colors = ["--legion", "--swarm", "--faceless"].map((v) =>
      styles.getPropertyValue(v).trim(),
    );
    const bands = [series.legion, series.swarm, series.faceless];

    const first = Math.max(0, viewStart);
    const last = Math.min(series.days.length - 1, viewEnd);

    // One line per faction against a shared axis, not stacked areas. Stacking
    // only lets the bottom band be read against a flat baseline; the two above
    // it are displaced by whatever is underneath, so comparing factions means
    // eyeballing thicknesses. Lines are directly comparable and the axis
    // labels then describe each faction rather than a running total.
    // Auto-scaled to the visible window rather than zero-based. Over a short
    // range the factions move a few percent, and a zero baseline crushes all
    // three lines into the top of the plot. The axis labels carry the absolute
    // values so the scale is never implied to start at zero.
    let lowest = Infinity;
    let highest = -Infinity;
    for (let d = first; d <= last; d++) {
      for (const band of bands) {
        if (band[d] < lowest) lowest = band[d];
        if (band[d] > highest) highest = band[d];
      }
    }
    if (!isFinite(lowest) || !isFinite(highest)) return;
    const pad = (highest - lowest) * 0.12 || Math.max(1, highest * 0.05);
    const yMin = Math.max(0, lowest - pad);
    const yMax = highest + pad;
    const yRange = Math.max(1e-9, yMax - yMin);
    const yOf = (v: number) => plotHeight - ((v - yMin) / yRange) * plotHeight;

    // Gridlines before the lines so they read as background.
    ctx.font = '9px var(--font-mono), ui-monospace, monospace';
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const step = niceStep(yRange, 3);
    for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.strokeStyle = "rgba(230,234,242,0.10)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotWidth, y);
      ctx.stroke();
      ctx.fillStyle = "rgba(124,135,152,0.95)";
      ctx.fillText(compact(v), plotWidth + 5, y);
    }

    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    bands.forEach((band, i) => {
      ctx.beginPath();
      for (let d = first; d <= last; d++) {
        const y = yOf(band[d]);
        d === first ? ctx.moveTo(x(d), y) : ctx.lineTo(x(d), y);
      }
      ctx.strokeStyle = colors[i];
      ctx.lineWidth = 1.6;
      ctx.globalAlpha = 0.95;
      ctx.stroke();
    });
    ctx.globalAlpha = 1;

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

    // Hover line, under the playhead so the committed date still reads first.
    if (hoverDay !== null && hoverDay !== day) {
      ctx.strokeStyle = "rgba(230,234,242,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x(hoverDay)) + 0.5, 0);
      ctx.lineTo(Math.round(x(hoverDay)) + 0.5, plotHeight);
      ctx.stroke();

      // A dot per faction where the hover crosses its line, so the tooltip
      // numbers are anchored to something on the plot.
      bands.forEach((band, i) => {
        const value = band[hoverDay];
        if (!(value > 0)) return;
        ctx.fillStyle = colors[i];
        ctx.beginPath();
        ctx.arc(x(hoverDay), yOf(value), 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // Playhead.
    ctx.strokeStyle = "var(--text)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x(day)) + 0.5, 0);
    ctx.lineTo(Math.round(x(day)) + 0.5, plotHeight);
    ctx.stroke();
  }, [series, viewStart, viewEnd, plotDays, day, epoch, gapYear, hoverDay]);

  useEffect(() => {
    draw();
    const observer = new ResizeObserver(draw);
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [draw]);

  const dayFromClientX = useCallback(
    (clientX: number): number | null => {
      const track = trackRef.current;
      if (!track) return null;
      const rect = track.getBoundingClientRect();
      const plotWidth = Math.max(10, rect.width - Y_GUTTER);
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / plotWidth));
      return Math.round(viewStart + ratio * plotDays);
    },
    [viewStart, plotDays],
  );

  const total =
    series && day < series.days.length
      ? series.legion[day] + series.swarm[day] + series.faceless[day]
      : 0;
  const before =
    series && viewStart < series.days.length
      ? series.legion[viewStart] + series.swarm[viewStart] + series.faceless[viewStart]
      : 0;
  // A percentage against the start of the record is meaningless: the game
  // began at nearly zero bots, so "All" produced +93,956,831.6%. Past a tenfold
  // change the honest reading is a multiple, and past a hundredfold neither
  // number tells you anything the chart does not.
  const growth = before > 0 ? total / before : null;
  const change = growth !== null && growth < 10 ? (growth - 1) * 100 : null;
  const multiple = growth !== null && growth >= 10 && growth < 100 ? growth : null;

  // Year, quarter or month labels depending on how much time is on screen.
  const ticks: { day: number; label: string }[] = [];
  {
    const epochMs = new Date(`${epoch}T00:00:00Z`).getTime();
    const start = dayToDate(epoch, viewStart);
    const end = dayToDate(epoch, viewEnd);
    const dayOf = (d: Date) => Math.floor((d.getTime() - epochMs) / 86_400_000);

    if (plotDays > 1500) {
      const stride = plotDays > 4000 ? 2 : 1;
      for (let y = start.getUTCFullYear() + 1; y <= end.getUTCFullYear(); y += stride) {
        ticks.push({ day: dayOf(new Date(Date.UTC(y, 0, 1))), label: String(y) });
      }
    } else {
      const stepMonths = plotDays > 400 ? 3 : 1;
      const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      while (cursor <= end) {
        ticks.push({
          day: dayOf(cursor),
          label:
            cursor.getUTCMonth() === 0
              ? String(cursor.getUTCFullYear())
              : cursor.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }),
        });
        cursor.setUTCMonth(cursor.getUTCMonth() + stepMonths);
      }
    }
  }

  /**
   * The hover tooltip's contents and where to put it.
   *
   * Only factions actually holding bots on that date appear - listing a flat
   * zero for a faction that had not launched yet reads as data rather than as
   * absence. Alphabetical, matching the stats panel, so the order never
   * implies a ranking.
   */
  const hoverReadout = (() => {
    if (hoverDay === null || !series || hoverDay >= series.days.length || hoverDay < 0) return null;
    const rows = (
      [
        ["Faceless", series.faceless[hoverDay], "var(--faceless)"],
        ["Legion", series.legion[hoverDay], "var(--legion)"],
        ["Swarm", series.swarm[hoverDay], "var(--swarm)"],
      ] as const
    )
      .filter(([, value]) => value > 0)
      .map(([label, value, color]) => ({ label, value, color }));
    if (!rows.length) return null;

    const ratio = (hoverDay - viewStart) / plotDays;
    const width = trackRef.current?.clientWidth ?? 0;
    const x = ratio * Math.max(10, width - Y_GUTTER);
    return { rows, x, flip: ratio > 0.72 };
  })();

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
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 6 }}>
        {onTogglePlay && (
          <button
            onClick={onTogglePlay}
            aria-label={playing ? "Pause playback" : "Play the history forward"}
            aria-pressed={playing}
            title={playing ? "Pause" : "Play the history forward"}
            style={{
              width: 26,
              height: 26,
              border: "1px solid var(--hairline-bright)",
              background: playing ? "var(--hairline)" : "transparent",
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
            }}
          >
            {/* Drawn rather than typed: the unicode glyphs render at wildly
                different weights across platforms next to a mono face. */}
            <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden fill="currentColor">
              {playing ? (
                <>
                  <rect x="0" y="0" width="3" height="10" />
                  <rect x="6" y="0" width="3" height="10" />
                </>
              ) : (
                <polygon points="0,0 9,5 0,10" />
              )}
            </svg>
          </button>
        )}
        <span className="eyebrow">{title}</span>
        <span className="display tabular" style={{ fontSize: 19, lineHeight: 1 }}>
          {compact(total)}
        </span>
        <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
          {subtitle}
          {(change !== null || multiple !== null) && (
            <>
              {" · "}
              {change !== null
                ? `${change > 0 ? "+" : ""}${change.toFixed(1)}%`
                : `${multiple!.toFixed(0)}x`}{" "}
              {windowPhrase(span)}
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
          {(mode === "zone" || mode === "area") && onClearFocus && (
            <button className="eyebrow" onClick={onClearFocus} style={button(true)}>
              Clear {mode === "zone" ? "zone" : "area"}
            </button>
          )}
        </div>
      </div>

      <div
        ref={trackRef}
        tabIndex={0}
        aria-label={`History chart. Showing ${title}. Click to set the date, or use the arrow keys.`}
        onPointerMove={(e) => setHoverDay(dayFromClientX(e.clientX))}
        onPointerLeave={() => setHoverDay(null)}
        onClick={(e) => {
          const picked = dayFromClientX(e.clientX);
          if (picked !== null) onScrub(Math.min(maxDay, Math.max(minDay, picked)));
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 30 : 1;
          if (e.key === "ArrowLeft") onScrub(Math.max(minDay, day - step));
          if (e.key === "ArrowRight") onScrub(Math.min(maxDay, day + step));
        }}
        style={{ position: "relative", height: CHART_HEIGHT, cursor: "crosshair" }}
      >
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
        {hoverReadout && (
          <div
            style={{
              position: "absolute",
              top: 4,
              // Flip to the other side of the cursor near the right edge so the
              // tooltip never runs off the plot.
              left: hoverReadout.flip ? undefined : hoverReadout.x + 10,
              right: hoverReadout.flip ? `calc(100% - ${hoverReadout.x - 10}px)` : undefined,
              padding: "5px 8px",
              background: "rgba(14,18,24,0.92)",
              backdropFilter: "var(--panel-blur)",
              WebkitBackdropFilter: "var(--panel-blur)",
              border: "1px solid var(--hairline-bright)",
              pointerEvents: "none",
              whiteSpace: "nowrap",
              zIndex: 5,
            }}
          >
            {hoverReadout.rows.map((row) => (
              <div
                key={row.label}
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}
              >
                <span
                  aria-hidden
                  style={{ width: 6, height: 6, background: row.color, flexShrink: 0 }}
                />
                <span style={{ color: "var(--text-dim)", flex: 1 }}>{row.label}</span>
                <span className="tabular" style={{ fontWeight: 600 }}>
                  {compact(row.value)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="eyebrow tabular" style={{ position: "relative", height: 16, marginTop: 2 }}>
        {ticks.map((tick) => (
          <span
            key={`${tick.day}-${tick.label}`}
            style={{
              position: "absolute",
              left: `calc(${((tick.day - viewStart) / plotDays) * 100}% - ${Y_GUTTER * ((tick.day - viewStart) / plotDays)}px)`,
              transform: "translateX(-50%)",
              // Dimmed under the hover date so the two never fight to be read.
              opacity: hoverDay === null ? 1 : 0.25,
            }}
          >
            {tick.label}
          </span>
        ))}
        {/* The hovered date, pinned to the axis at the cursor. */}
        {hoverDay !== null && (
          <span
            style={{
              position: "absolute",
              left: `calc(${((hoverDay - viewStart) / plotDays) * 100}% - ${Y_GUTTER * ((hoverDay - viewStart) / plotDays)}px)`,
              transform: "translateX(-50%)",
              color: "var(--text)",
              background: "var(--ink)",
              padding: "0 4px",
              whiteSpace: "nowrap",
            }}
          >
            {dayToDate(epoch, hoverDay).toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "numeric",
              timeZone: "UTC",
            })}
          </span>
        )}
        {status && <span style={{ position: "absolute", right: 0 }}>{status}</span>}
      </div>
    </section>
  );
}
