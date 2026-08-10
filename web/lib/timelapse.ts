"use client";

/**
 * The MAZ timelapse, as two hooks the page wires together.
 *
 * Split because of an ordering constraint rather than taste: the flip stream has
 * to hand `absorb` to `useZoneData` *before* that hook runs, while the layers
 * need the geometry and display state it returns. One hook cannot do both.
 *
 *   useFlipStream   accumulates the worker's answers - a fading trail and a
 *                   cumulative mask - without touching React state per answer.
 *   useMazOverlays  turns marks, flips and the geometry into deck.gl layers.
 *
 * Neither reads the DOM beyond CSS variables, and neither owns a date; the page
 * decides which day is showing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { ZoneDisplay, ZoneGeometry } from "./geometry";
import { marksFor, type MazData } from "./maz";
import type { DayFlips } from "./useZoneData";

/**
 * What the dots underneath show while the timelapse runs.
 *
 * `daily` — only zones with an event that day.
 * `all` — the standings: every zone holding bots on that date.
 * `cumulative` — starts unclaimed and fills in. A zone appears the day it
 *   changes hands and stays for the rest of the run, in whatever color it
 *   currently holds.
 */
export type Backdrop = "daily" | "all" | "cumulative";

/**
 * Trailing window a MAZ ring counts appearances over.
 *
 * A density dial rather than a meaning one: the median zone appears once in the
 * window and the 90th percentile about five times at every length from 14 to
 * 180 days. Thirty draws about 114 rings worldwide.
 */
export const MAZ_WINDOW_DAYS = 30;

/** Days a change of hands stays on the map after the day it happened. */
export const FLIP_TRAIL_DAYS = 5;

/** Playback advances one day per frame and never more; this is the ceiling. */
export const PLAY_DAYS_PER_SECOND = 30;

// Amber, and specifically not any of the three faction colors. A MAZ is not a
// faction fact, and a mark that borrows red, green or purple says one.
const MAZ_COLOR = [255, 200, 87] as const;
// A report landing on the playhead's own day, as against one persisting from an
// earlier one. Near-white so "new" is legible inside a field of amber.
const MAZ_FRESH = [255, 246, 224] as const;

const MIN_PX = 2;
const MAX_PX = 8;

/**
 * Radius of a flip mark in screen pixels, as a function of zoom.
 *
 * Not a constant. A zone dot is drawn in meters capped at 9 px, so it is a speck
 * at world zoom and a fat disc by zoom 8 - a fixed mark that reads over the
 * whole world vanishes *inside* the dot it annotates as soon as anyone zooms in.
 */
const flipRadius = (zoom: number): number =>
  2.6 + 6.6 * Math.max(0, Math.min(1, (zoom - 3) / 5));

const FACTION_VARS = ["--dormant", "--legion", "--swarm", "--faceless"] as const;

function factionColors(): number[][] {
  const styles = getComputedStyle(document.documentElement);
  return FACTION_VARS.map((name) => {
    const hex = styles.getPropertyValue(name).trim();
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  });
}

// --- the flip stream -------------------------------------------------------

export interface FlipStream {
  /** Hand this to `useZoneData` so answers are absorbed as they land. */
  absorb: (answer: DayFlips) => void;
  /** The fading trail, newest last. */
  frames: DayFlips[];
  /** Cumulative mask, or null outside `cumulative`. Indexed by zone idx. */
  mask: Uint8Array | null;
  /** Bumped when any of the above is mutated in place. */
  version: number;
  /** Zones in the cumulative mask. */
  claimed: number;
}

/**
 * Accumulate the worker's flip answers.
 *
 * Everything lives in refs and publishes with a single version bump, and the
 * work happens in the answer handler rather than an effect. An effect that sets
 * state on every answer makes React count a nested passive update on every frame
 * of playback; after fifty without a quiet commit in between it logs "Maximum
 * update depth exceeded" and the console fills up.
 */
export function useFlipStream(
  zoneCount: number | null,
  backdrop: Backdrop,
  /** Restart the accumulation whenever the run's starting point moves. */
  anchor: number | null,
): FlipStream {
  const frames = useRef<DayFlips[]>([]);
  const mask = useRef<Uint8Array | null>(null);
  const maskDay = useRef<number | null>(null);
  const claimed = useRef(0);
  const mode = useRef<Backdrop>(backdrop);
  mode.current = backdrop;
  const [version, setVersion] = useState(0);

  useEffect(() => {
    // Allocated zeroed rather than left null, so entering the mode shows an
    // unclaimed world immediately. A null mask means "no restriction", which
    // would flash the full standings before the first answer arrived.
    mask.current =
      backdrop === "cumulative" && zoneCount ? new Uint8Array(zoneCount) : null;
    maskDay.current = null;
    claimed.current = 0;
    frames.current = [];
    setVersion((v) => v + 1);
  }, [backdrop, anchor, zoneCount]);

  const absorb = useCallback((answer: DayFlips) => {
    // The trail is dropped whenever the answered day is not the previous one
    // plus one. After a scrub, or while the map trails the playhead and skips
    // days, consecutive answers are not consecutive days, and stacking them
    // would draw a trail that never happened.
    const previous = frames.current;
    if (!previous.some((f) => f.day === answer.day)) {
      const newest = previous.length ? previous[previous.length - 1].day : null;
      const next = newest !== null && answer.day === newest + 1 ? [...previous, answer] : [answer];
      frames.current = next.filter((f) => answer.day - f.day < FLIP_TRAIL_DAYS);
    }

    const bits = mask.current;
    if (bits && mode.current === "cumulative") {
      // Scrubbed backwards: start the accumulation again from here.
      if (maskDay.current !== null && answer.day <= maskDay.current) {
        bits.fill(0);
        claimed.current = 0;
      }
      maskDay.current = answer.day;
      for (let i = 0; i < answer.idx.length; i++) {
        const idx = answer.idx[i];
        if (bits[idx] === 0) {
          bits[idx] = 1;
          claimed.current++;
        }
      }
    }

    setVersion((v) => v + 1);
  }, []);

  return {
    absorb,
    frames: frames.current,
    mask: mask.current,
    version,
    claimed: claimed.current,
  };
}

// --- the layers ------------------------------------------------------------

export interface MazOverlays {
  layers: ScatterplotLayer[];
  /** MAZ rings drawn, after the focus mask. */
  marks: number;
  /** Change-of-hands marks drawn. */
  flips: number;
}

export interface OverlayInput {
  maz: MazData | null;
  geometry: ZoneGeometry | null;
  display: ZoneDisplay | null;
  /** Bumped when `display` is refilled in place. */
  version: number;
  day: number | null;
  zoom: number;
  /** Zones in focus, or null for the whole world. */
  focus: Uint8Array | null;
  stream: FlipStream;
}

export function useMazOverlays({
  maz,
  geometry,
  display,
  version,
  day,
  zoom,
  focus,
  stream,
}: OverlayInput): MazOverlays {
  const marks = useMemo(
    () => (maz && day !== null ? marksFor(maz, day, MAZ_WINDOW_DAYS) : null),
    [maz, day],
  );

  const mazLayers = useMemo(() => {
    if (!marks || marks.count === 0 || !geometry) return { layers: [] as ScatterplotLayer[], count: 0 };
    const { intensity, weight, fresh, count } = marks;

    const positions = new Float32Array(count * 2);
    const line = new Uint8Array(count * 4);
    const radius = new Float32Array(count);
    let kept = 0;

    for (let i = 0; i < count; i++) {
      const idx = marks.idx[i];
      if (geometry.idxToSlot[idx] < 0) continue;
      if (focus && focus[idx] === 0) continue;
      const rgb = fresh[i] === 1 ? MAZ_FRESH : MAZ_COLOR;
      const a = intensity[i];
      const o = kept * 4;
      positions[kept * 2] = geometry.longitude[idx];
      positions[kept * 2 + 1] = geometry.latitude[idx];
      line[o] = rgb[0];
      line[o + 1] = rgb[1];
      line[o + 2] = rgb[2];
      line[o + 3] = Math.round(60 + 175 * a);
      radius[kept] = MIN_PX + (MAX_PX - MIN_PX) * weight[i];
      kept++;
    }
    if (kept === 0) return { layers: [] as ScatterplotLayer[], count: 0 };

    const data = {
      length: kept,
      attributes: {
        getPosition: { value: positions.subarray(0, kept * 2), size: 2 },
        getLineColor: { value: line.subarray(0, kept * 4), size: 4 },
        getRadius: { value: radius.subarray(0, kept), size: 1 },
      },
    };

    return {
      count: kept,
      layers: [
        new ScatterplotLayer({
          id: "maz-ring",
          data,
          radiusUnits: "pixels",
          stroked: true,
          filled: false,
          lineWidthUnits: "pixels",
          getLineWidth: 1.4,
          lineWidthMinPixels: 1,
          pickable: false,
          parameters: { depthTest: false },
          updateTriggers: { all: data },
        }),
      ],
    };
  }, [marks, geometry, focus]);

  const flipArrays = useMemo(() => {
    const nothing = { positions: new Float32Array(0), fill: new Uint8Array(0), backing: new Uint8Array(0), count: 0 };
    if (!geometry || stream.frames.length === 0) return nothing;
    const palette = factionColors();
    const newest = stream.frames[stream.frames.length - 1].day;

    let total = 0;
    for (const frame of stream.frames) total += frame.idx.length;

    const positions = new Float32Array(total * 2);
    const fill = new Uint8Array(total * 4);
    const backing = new Uint8Array(total * 4);
    let kept = 0;

    for (const frame of stream.frames) {
      // Older days fade rather than vanish, so direction of travel reads
      // without a second encoding.
      const fade = 1 - (newest - frame.day) / FLIP_TRAIL_DAYS;
      for (let i = 0; i < frame.idx.length; i++) {
        const idx = frame.idx[i];
        // A zone whose tile has not landed has no coordinates.
        const slot = geometry.idxToSlot[idx];
        if (slot < 0) continue;
        // A mark must not describe a zone the map is hiding. `visible` is held
        // by slot, so this goes through the slot we already have.
        if (display && display.visible[slot] === 0) continue;
        if (focus && focus[idx] === 0) continue;

        const rgb = palette[frame.to[i]] ?? palette[0];
        positions[kept * 2] = geometry.longitude[idx];
        positions[kept * 2 + 1] = geometry.latitude[idx];
        const o = kept * 4;
        fill[o] = rgb[0];
        fill[o + 1] = rgb[1];
        fill[o + 2] = rgb[2];
        fill[o + 3] = Math.round(255 * fade);
        // A dark disc underneath rather than a stroke around: at this size a
        // stroke is most of the mark and the color it carries never shows.
        backing[o] = 6;
        backing[o + 1] = 8;
        backing[o + 2] = 13;
        backing[o + 3] = Math.round(225 * fade);
        kept++;
      }
    }
    if (kept === 0) return nothing;

    return {
      positions: positions.subarray(0, kept * 2),
      fill: fill.subarray(0, kept * 4),
      backing: backing.subarray(0, kept * 4),
      count: kept,
    };
    // `version` says the visible mask was refilled in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.frames, stream.version, geometry, display, version, focus]);

  const flipLayers = useMemo(() => {
    const { positions, fill, backing, count } = flipArrays;
    if (count === 0) return [] as ScatterplotLayer[];
    const radius = flipRadius(zoom);
    const shape = (colors: Uint8Array) => ({
      length: count,
      attributes: {
        getPosition: { value: positions, size: 2 },
        getFillColor: { value: colors, size: 4 },
      },
    });
    const trigger = [flipArrays, radius];

    return [
      new ScatterplotLayer({
        id: "flips-backing",
        data: shape(backing),
        getRadius: radius + 1.3,
        radiusUnits: "pixels",
        stroked: false,
        filled: true,
        pickable: false,
        parameters: { depthTest: false },
        updateTriggers: { all: trigger },
      }),
      new ScatterplotLayer({
        id: "flips",
        data: shape(fill),
        getRadius: radius,
        radiusUnits: "pixels",
        stroked: false,
        filled: true,
        pickable: false,
        parameters: { depthTest: false },
        updateTriggers: { all: trigger },
      }),
    ];
  }, [flipArrays, zoom]);

  // Flips underneath: there are a hundred times as many, and a MAZ is the
  // bigger claim. The other way round the amber disappears into them.
  const layers = useMemo(
    () => [...flipLayers, ...mazLayers.layers],
    [flipLayers, mazLayers],
  );

  return { layers, marks: mazLayers.count, flips: flipArrays.count };
}

