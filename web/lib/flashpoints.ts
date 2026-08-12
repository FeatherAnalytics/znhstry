"use client";

/**
 * Flashpoints: a named day, framed on the map, with what it did to the bots around it.
 *
 * The definitions ride in `meta.json` because they are four kilobytes and the manifest is
 * already fetched; only the impact series costs a request, and there is one shard for all
 * of them rather than one each. Requests are the binding constraint on an `r2.dev` URL
 * with no CDN in front of it, which is the same reason the tile grid is 16 degrees.
 *
 * Nothing here reaches into the zone buffers. The marks are `overlays`, the circle is the
 * existing `ring` prop, and the dimming is an ordinary focus mask.
 */

import { ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import type { MapViewState } from "@deck.gl/core";
import { loadShard, type ShardEntry } from "./format";
import type { ZoneGeometry } from "./geometry";

/**
 * How much wider than its own circle a flashpoint is framed.
 *
 * Wider on purpose. Framing exactly on the circle puts the interesting zones against the
 * edges of the screen with no surroundings to read them against, and the whole claim of a
 * flashpoint is that something local happened - which needs the local area visible. At the
 * default 48.28 km radius this shows about 50 miles.
 *
 * Derived from each flashpoint's own `radiusKm` rather than fixed, because that radius is
 * what the impact series was actually summed over. A second constant here would be a
 * second source of truth for one circle: re-seed a flashpoint wider and the ring drawn
 * would stop matching the numbers beside it.
 */
export const FRAME_RATIO = 5 / 3;

/**
 * Days per second while a flashpoint is playing.
 *
 * The record-crossing rate is 30, which is right for its own promise and wrong for this
 * one: at 30 a Marquette run finishes in under two seconds and the day the fight happened
 * is a single frame. A flashpoint is a few days in one neighborhood, so the run is short
 * enough to afford being slow, and being slow is the entire point.
 */
export const FLASHPOINT_DAYS_PER_SECOND = 2.5;

/**
 * Days per second while the playhead stands on the flashpoint's own days.
 *
 * A third of a day a second, so each board day holds the screen for three seconds. Those
 * days are the reason the run exists, and at the surrounding pace they pass in under half a
 * second - the same fraction of the run as any other day, which is precisely wrong.
 */
export const FLASHPOINT_BOARD_DAYS_PER_SECOND = 1 / 3;

/** Days a flashpoint's marks keep fading for after the board window closes. */
export const FLASHPOINT_TRAIL_DAYS = 10;

// Near-white, and deliberately none of the three faction colors. Being on the leaderboard
// is not a faction fact - the same reason the recurrence rings are amber.
const BOARD_COLOR = [255, 246, 224] as const;
// The amber the recurrence rings use, for a board zone outside its own board window.
const BOARD_DORMANT = [255, 200, 87] as const;

export interface Flashpoint {
  id: string;
  label: string;
  blurb: string;
  anchor: { lat: number; lon: number };
  /** The flashpoint's own days: what `onTheBoard` was measured over. */
  boardStart: number;
  boardEnd: number;
  /** What playback covers, normally the board window plus 28 either side. */
  runStart: number;
  runEnd: number;
  radiusKm: number;
  /** Zones on the leaderboard inside the board window, by export idx. */
  boardIdx: Uint32Array;
  zonesInCircle: number;
  /**
   * False when the changelog has no events for the board zones in this window, which is
   * every flashpoint before 2020. Absence and zero are different answers and the panel
   * must not draw the second when it has the first.
   */
  changelogCovered: boolean;
}

export interface FlashpointsMeta extends ShardEntry {
  entries: {
    id: string;
    label: string;
    blurb: string;
    lat: number;
    lon: number;
    board: [number, number];
    run: [number, number];
    radius_km: number;
    board_idx: number[];
    zones_in_circle: number;
    changelog_covered: boolean;
  }[];
}

export function readFlashpoints(meta: FlashpointsMeta): Flashpoint[] {
  return meta.entries.map((e) => ({
    id: e.id,
    label: e.label,
    blurb: e.blurb,
    anchor: { lat: e.lat, lon: e.lon },
    boardStart: e.board[0],
    boardEnd: e.board[1],
    runStart: e.run[0],
    runEnd: e.run[1],
    radiusKm: e.radius_km,
    boardIdx: new Uint32Array(e.board_idx),
    zonesInCircle: e.zones_in_circle,
    changelogCovered: e.changelog_covered,
  }));
}

export interface ImpactSeries {
  /** Net change on each day of the run, for zones that were on the board. */
  board: Float64Array;
  /** The same for every other zone in the circle. */
  neighbors: Float64Array;
  /** Distinct zones with an event that day, both groups together. */
  moving: Int32Array;
  /** `board[i]` is `firstDay + i`. */
  firstDay: number;
}

/**
 * Every flashpoint's series, in one fetch, densified per flashpoint.
 *
 * The shard is sparse - a day where nothing moved has no row - which is the same contract
 * as every other series here. Densifying on arrival is what lets the panel index by day
 * without carrying the sparseness into the drawing code.
 */
export async function loadImpact(
  base: string,
  meta: FlashpointsMeta,
  flashpoints: Flashpoint[],
): Promise<Map<string, ImpactSeries>> {
  const columns = await loadShard(base, meta);
  const which = columns.flashpoint as Uint8Array;
  const day = columns.day as Uint16Array;
  const onBoard = columns.on_the_board as Uint8Array;
  const net = columns.net_delta as Int32Array;
  const moving = columns.zones_moving as Uint16Array;

  // The shard's `flashpoint` column is a position in `meta.entries`, so the code has to
  // come from there and never from the order of whatever list a caller passed in. A
  // picker sorted by label, or filtered to the covered ones, would otherwise attribute
  // Dallas's series to Marquette - silently, since both are plausible.
  const codeOf = new Map(meta.entries.map((entry, position) => [entry.id, position]));

  const out = new Map<string, ImpactSeries>();
  flashpoints.forEach((f) => {
    const order = codeOf.get(f.id);
    if (order === undefined) return;
    const span = f.runEnd - f.runStart + 1;
    const series: ImpactSeries = {
      board: new Float64Array(span),
      neighbors: new Float64Array(span),
      moving: new Int32Array(span),
      firstDay: f.runStart,
    };
    for (let i = 0; i < which.length; i++) {
      if (which[i] !== order) continue;
      const at = day[i] - f.runStart;
      if (at < 0 || at >= span) continue;
      if (onBoard[i] === 1) series.board[at] += net[i];
      else series.neighbors[at] += net[i];
      series.moving[at] += moving[i];
    }
    out.set(f.id, series);
  });
  return out;
}

/** Net change over `[from, to]` inclusive, in days. */
export function netOver(series: Float64Array, firstDay: number, from: number, to: number): number {
  let total = 0;
  const last = Math.min(to - firstDay, series.length - 1);
  for (let at = Math.max(0, from - firstDay); at <= last; at++) total += series[at];
  return total;
}

/**
 * Where to put the camera.
 *
 * The same arithmetic the near-me path uses: a span of latitude in degrees, widened by
 * `1 / cos(latitude)` because a degree of longitude shrinks towards the poles, then handed
 * to the caller's `zoomFor`. At Marquette this lands near zoom 7, and that is worth
 * knowing for a second reason - our own boundary rings fade out above zoom 5 and are gone
 * by 7, so orientation at a flashpoint comes entirely from the basemap's coastlines, roads
 * and place names. That is correct rather than a gap: the rings are simplified to 0.01
 * degrees and are plainly wrong at city zoom.
 */
export function framing(
  flashpoint: Flashpoint,
  zoomFor: (spanLon: number, spanLat: number) => number,
): MapViewState {
  const spanLat = ((flashpoint.radiusKm * FRAME_RATIO) / 111.32) * 2;
  const cosine = Math.max(0.2, Math.cos((flashpoint.anchor.lat * Math.PI) / 180));
  return {
    latitude: flashpoint.anchor.lat,
    longitude: flashpoint.anchor.lon,
    zoom: zoomFor(spanLat / cosine, spanLat),
  };
}

/**
 * Radius of a board mark in screen pixels, as a function of zoom.
 *
 * Grows with zoom for the same reason the flip marks do: a zone dot is drawn in meters
 * capped at 9 px, so a fixed mark that reads over the whole world disappears *inside* the
 * dot it annotates by the time anyone is close enough to see the neighborhood. Larger than
 * a flip mark throughout, because a flashpoint has at most ten of these against a
 * thousand flips and it is the stronger claim on screen.
 */
function boardRadius(zoom: number): number {
  return 6 + 14 * Math.max(0, Math.min(1, (zoom - 3) / 5));
}

/**
 * A slow pulse, so a board zone reads as marked while the map is still.
 *
 * Driven by the playhead rather than by wall-clock time, so the mark is a function of the
 * date on screen and a paused map is a still picture rather than a breathing one. A
 * timelapse whose marks animate independently of the day it is showing invites the reader
 * to read motion as change.
 */
function pulse(day: number, boardStart: number, boardEnd: number): number {
  if (day < boardStart) return 0.25;
  if (day <= boardEnd) return 1;
  const faded = 1 - (day - boardEnd) / FLASHPOINT_TRAIL_DAYS;
  return Math.max(0.25, faded);
}

export interface BoardLayerInput {
  flashpoint: Flashpoint;
  geometry: ZoneGeometry;
  /** The playhead, so the marks answer to the date and not to the clock. */
  day: number;
  zoom: number;
  /** Zone names by idx, when the hover path has already fetched the blocks. */
  nameOf?: (idx: number) => string | null;
}

/**
 * Two concentric rings per board zone, plus names once the zoom can carry them.
 *
 * Two rather than one thicker ring, because Marquette's five zones sit inside 25.8 km and
 * at zoom 7 they overlap - a single stroke merges into its neighbor and the count is lost.
 * The names wait for zoom 8: five labels collide at 7 and do not at 9.
 */
export function boardLayers({
  flashpoint,
  geometry,
  day,
  zoom,
  nameOf,
}: BoardLayerInput): (ScatterplotLayer | TextLayer)[] {
  const idx = flashpoint.boardIdx;
  const positions = new Float32Array(idx.length * 2);
  const color = new Uint8Array(idx.length * 4);
  let kept = 0;

  const strength = pulse(day, flashpoint.boardStart, flashpoint.boardEnd);
  const rgb = day >= flashpoint.boardStart && day <= flashpoint.boardEnd ? BOARD_COLOR : BOARD_DORMANT;

  for (let i = 0; i < idx.length; i++) {
    // A zone whose tile has not landed has no coordinates yet.
    if (geometry.idxToSlot[idx[i]] < 0) continue;
    positions[kept * 2] = geometry.longitude[idx[i]];
    positions[kept * 2 + 1] = geometry.latitude[idx[i]];
    const o = kept * 4;
    color[o] = rgb[0];
    color[o + 1] = rgb[1];
    color[o + 2] = rgb[2];
    color[o + 3] = Math.round(70 + 185 * strength);
    kept++;
  }
  if (kept === 0) return [];

  const radius = boardRadius(zoom);
  const shape = () => ({
    length: kept,
    attributes: {
      getPosition: { value: positions.subarray(0, kept * 2), size: 2 },
      getLineColor: { value: color.subarray(0, kept * 4), size: 4 },
    },
  });
  const trigger = [positions, color, radius, kept];

  const rings = [radius, radius * 1.45].map(
    (px, n) =>
      new ScatterplotLayer({
        id: `flashpoint-ring-${n}`,
        data: shape(),
        getRadius: px,
        radiusUnits: "pixels",
        stroked: true,
        filled: false,
        lineWidthUnits: "pixels",
        getLineWidth: n === 0 ? 2 : 1,
        lineWidthMinPixels: 1,
        pickable: false,
        parameters: { depthTest: false },
        updateTriggers: { all: trigger },
      }),
  );

  if (zoom < 8 || !nameOf) return rings;

  const labels: { position: [number, number]; text: string }[] = [];
  for (let i = 0; i < idx.length; i++) {
    if (geometry.idxToSlot[idx[i]] < 0) continue;
    const text = nameOf(idx[i]);
    if (text) labels.push({ position: [geometry.longitude[idx[i]], geometry.latitude[idx[i]]], text });
  }
  if (labels.length === 0) return rings;

  return [
    ...rings,
    new TextLayer({
      id: "flashpoint-label",
      data: labels,
      getPosition: (d) => d.position,
      getText: (d) => d.text,
      getSize: 12,
      getColor: [...BOARD_COLOR, 235],
      getPixelOffset: [0, -(radius * 1.45 + 9)],
      fontWeight: 600,
      outlineWidth: 3,
      outlineColor: [6, 8, 13, 255],
      fontSettings: { sdf: true },
      pickable: false,
      parameters: { depthTest: false },
      updateTriggers: { getPixelOffset: radius },
    }),
  ];
}
