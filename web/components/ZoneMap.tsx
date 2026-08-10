"use client";

import { useMemo, useRef } from "react";
import DeckGL from "@deck.gl/react";
import { ScatterplotLayer, PathLayer, LineLayer, BitmapLayer } from "@deck.gl/layers";
import { TileLayer } from "@deck.gl/geo-layers";
import {
  WebMercatorViewport,
  type LayersList,
  type MapViewState,
  type PickingInfo,
} from "@deck.gl/core";
import type { ZoneDisplay, ZoneGeometry } from "@/lib/geometry";
import type { BoundaryLayer } from "@/lib/boundaries";

// A 15-degree graticule, drawn dimmer than any boundary. It is orientation of
// last resort, not decoration.
function graticule(step = 15) {
  const lines: { from: [number, number]; to: [number, number] }[] = [];
  for (let lon = -180; lon <= 180; lon += step) lines.push({ from: [lon, -85], to: [lon, 85] });
  for (let lat = -75; lat <= 75; lat += step) lines.push({ from: [-180, lat], to: [180, lat] });
  return lines;
}

const FACTION_VARS = ["--dormant", "--legion", "--swarm", "--faceless"] as const;

function readFactionColors(): number[][] {
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

/** A ring of `steps` points at `radiusKm` around a point, for the range overlay. */
function circle(lat: number, lon: number, radiusKm: number, steps = 180): [number, number][] {
  const R = 6371.0088;
  const angular = radiusKm / R;
  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  const points: [number, number][] = [];

  for (let i = 0; i <= steps; i++) {
    const bearing = (i / steps) * 2 * Math.PI;
    const sinLat = Math.sin(phi) * Math.cos(angular) + Math.cos(phi) * Math.sin(angular) * Math.cos(bearing);
    const lat2 = Math.asin(sinLat);
    const lon2 =
      lambda +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(phi),
        Math.cos(angular) - Math.sin(phi) * sinLat,
      );
    points.push([((lon2 * 180) / Math.PI + 540) % 360 - 180, (lat2 * 180) / Math.PI]);
  }
  return points;
}

export interface RangeRing {
  lat: number;
  lon: number;
  radiusKm: number;
}

export interface ZoneMapProps {
  geometry: ZoneGeometry;
  /** What to draw. Filled by the paint files, then by the exact counts. */
  display: ZoneDisplay;
  version: number;
  boundaries: BoundaryLayer[];
  viewState: MapViewState;
  /** Zones outside the filter are dimmed rather than hidden. */
  filter: Uint8Array | null;
  /**
   * Which zone dots to draw.
   *
   * `all` — the whole world: empty zones always, held ones per the change window.
   * `empty` — zones holding nothing, and nothing else.
   *
   * There is no "hide the empty ones" state. Hiding the 1.09M never played plus
   * everything fought down to nothing removed most of the map to answer a
   * question nobody had; the useful question is the opposite one, "where is
   * there nothing", and that is what `empty` shows.
   *
   * Empty zones answer to this and never to the change window. "This zone holds
   * nothing" is a fact about now, not about the span.
   */
  draw: "all" | "empty";
  /**
   * When set, a zone holding bots is drawn only if its byte here is 1.
   *
   * Empty zones ignore it, so the unclaimed world stays as the base layer. This
   * is what a cumulative view is built on: hand in a mask that only ever gains
   * entries and the map fills in as the run proceeds.
   */
  only?: Uint8Array | null;
  /** Bumped when `only` is mutated in place, which identity alone cannot show. */
  onlyVersion?: number;
  ring: RangeRing | null;
  /**
   * Layers drawn over the dots and the boundaries.
   *
   * The map owns the zones and nothing else should reach into that buffer, but
   * an overlay that sits *on top* of it needs no access to it at all. Kept as an
   * escape hatch so a new layer is a caller's concern rather than another branch
   * in here.
   */
  overlays?: LayersList;
  onViewStateChange: (next: MapViewState) => void;
  /** Receives a zone idx, or null when the pointer leaves the dots. */
  onHover: (idx: number | null) => void;
  onClickZone: (idx: number | null) => void;
  onBounds: (bounds: [number, number, number, number]) => void;
}

export function ZoneMap({
  geometry,
  display,
  version,
  boundaries,
  viewState,
  filter,
  draw,
  only,
  onlyVersion,
  ring,
  overlays,
  onViewStateChange,
  onHover,
  onClickZone,
  onBounds,
}: ZoneMapProps) {
  const colors = useRef(new Uint8Array(geometry.size * 4));
  const radii = useRef(new Float32Array(geometry.size));
  // Positions are copied rather than referenced because the draw list is
  // compacted -- see below. Sized for the worst case, used up to `drawn`.
  const points = useRef(new Float32Array(geometry.size * 2));
  /** Draw row -> slot, so a pick can be turned back into a zone. */
  const drawnToSlot = useRef(new Int32Array(geometry.size));
  const drawn = useRef(0);

  // The 1,087,356 zones never played in fourteen years. Their colour and radius
  // cannot change with the date - they are empty in every frame of every year -
  // so they are built once and left alone, instead of being walked and
  // re-uploaded 2.68M-at-a-time on every step of a timelapse.
  const terrainPoints = useRef(new Float32Array(geometry.size * 2));
  const terrainColors = useRef(new Uint8Array(geometry.size * 4));
  const terrainToSlot = useRef(new Int32Array(geometry.size));
  const terrain = useRef(0);

  // Binary attributes rather than accessor functions. deck.gl calls an
  // accessor once per object per update, which is fine for 144k zones and far
  // too slow at 2.7M -- filling typed arrays directly keeps a global scrub
  // interactive.
  //
  // Filled during render, not in an effect: the layer below is constructed
  // from these same arrays, so an effect would populate them one frame after
  // deck.gl had already read them as zeroes.
  //
  // Indexed by *slot*, the render order tiles arrive in, while game state is
  // indexed by *idx*. slotToIdx is the bridge and the reason this loop looks
  // indirect.
  useMemo(() => {
    const palette = readFactionColors();
    const colorArray = colors.current;
    const radiusArray = radii.current;
    const pointArray = points.current;
    const backToSlot = drawnToSlot.current;
    const { slotToIdx, everActive, count, positions } = geometry;
    let n = 0;

    for (let slot = 0; slot < count; slot++) {
      const idx = slotToIdx[slot];
      // One byte carries both facts, so this is one memory read per zone
      // rather than two - which matters when the loop runs 2.68M times on
      // every scrub.
      // Never-played zones live in the terrain layer below and are skipped here.
      if (everActive[idx] === 0) continue;

      const pk = display.pk[idx];
      const magnitude = pk & 63;

      // Empty zones are always drawn; held zones answer to the change window,
      // or are dropped outright when the reader asked for empty ones only.
      //
      // Skipped rather than written at zero alpha. A hidden zone used to keep
      // its row so the buffers could stay slot-aligned, which meant the GPU
      // processed 2.68M instances and re-uploaded 43 MB whatever was on screen -
      // and on the Day view about three thousand zones are visible. Compacting
      // costs one indirection on pick and buys two orders of magnitude here.
      if (magnitude !== 0 && (draw === "empty" || display.visible[idx] === 0)) continue;
      if (magnitude !== 0 && only !== null && only !== undefined && only[idx] === 0) continue;

      const o = n * 4;
      pointArray[n * 2] = positions[slot * 2];
      pointArray[n * 2 + 1] = positions[slot * 2 + 1];
      backToSlot[n] = slot;

      // Outside the filter a zone stays on the map but stops competing for
      // attention. It is context, not data: dimming to a quarter was not
      // enough, because there are two million of them and faint times two
      // million still reads as a wash of colour.
      const muted = filter !== null && filter[idx] === 0;

      if (magnitude > 0) {
        const rgb = palette[pk >> 6] ?? palette[0];
        colorArray[o] = rgb[0];
        colorArray[o + 1] = rgb[1];
        colorArray[o + 2] = rgb[2];
        colorArray[o + 3] = muted ? 26 : 215;
        // Counts span six orders of magnitude, so size is logarithmic and
        // capped in pixels. Colour carries who holds a zone; size stays quiet.
        radiusArray[n] = muted ? 300 : display.radius(magnitude);
      } else {
        // An empty zone is grey whoever nominally holds it: with no bots there
        // is nothing to own, and colouring it by faction overstates control.
        // This branch is only ever a zone that has been played and fought down
        // to nothing - part of the story. One never touched in fourteen years
        // is terrain, and is drawn by the layer below.
        colorArray[o] = palette[0][0];
        colorArray[o + 1] = palette[0][1];
        colorArray[o + 2] = palette[0][2];
        colorArray[o + 3] = muted ? 12 : 110;
        radiusArray[n] = 400;
      }
      n++;
    }
    drawn.current = n;
  }, [geometry, display, version, filter, draw, only, onlyVersion]);

  /**
   * Terrain: built as tiles land and when the filter moves, and never per date.
   *
   * Keyed on `geometry.count` rather than `version`, which is the whole point -
   * `version` bumps on every scrub and every playback step, and this must not.
   * The count changes only while tiles are arriving, so during a timelapse these
   * buffers are uploaded zero times.
   */
  const terrainCount = geometry.count;
  useMemo(() => {
    const palette = readFactionColors();
    const colorArray = terrainColors.current;
    const pointArray = terrainPoints.current;
    const backToSlot = terrainToSlot.current;
    const { slotToIdx, everActive, positions } = geometry;
    let n = 0;

    for (let slot = 0; slot < terrainCount; slot++) {
      const idx = slotToIdx[slot];
      if (everActive[idx] !== 0) continue;
      const o = n * 4;
      pointArray[n * 2] = positions[slot * 2];
      pointArray[n * 2 + 1] = positions[slot * 2 + 1];
      backToSlot[n] = slot;
      colorArray[o] = palette[0][0];
      colorArray[o + 1] = palette[0][1];
      colorArray[o + 2] = palette[0][2];
      colorArray[o + 3] = filter !== null && filter[idx] === 0 ? 12 : 55;
      n++;
    }
    terrain.current = n;
  }, [geometry, terrainCount, filter, draw]);

  const terrainData = useMemo(
    () => ({
      length: terrain.current,
      attributes: {
        getPosition: { value: terrainPoints.current, size: 2 },
        getFillColor: { value: terrainColors.current, size: 4 },
      },
    }),
    [geometry, terrainCount, filter, draw],
  );

  // Full strength out to zoom 5, gone by 7. Our rings are a world-scale
  // simplification; the basemap's borders take over as they stop being.
  const zoom = viewState.zoom ?? 0;
  const boundaryAlpha = Math.max(0, Math.min(1, (7 - zoom) / 2));

  /**
   * The binary attribute bundles, held by identity across renders.
   *
   * deck.gl treats a new `data` object as new data. These are object literals,
   * so writing them inline hands it a fresh one on *every* render and it
   * re-uploads 43 MB of positions, colours and radii each time - including on
   * renders that changed nothing it draws, such as a parent re-rendering for an
   * overlay. That capped playback at about eleven frames a second no matter what
   * else was going on.
   *
   * The typed arrays inside are mutated in place and deck.gl cannot see that, so
   * `updateTriggers: version` is still what makes a repaint happen. This only
   * stops the uploads nobody asked for.
   */
  const zoneData = useMemo(
    () => ({
      length: drawn.current,
      attributes: {
        getPosition: { value: points.current, size: 2 },
        getFillColor: { value: colors.current, size: 4 },
        getRadius: { value: radii.current, size: 1 },
      },
    }),
    // Every input that can change how many rows are drawn, or what is in them.
    // The arrays are mutated in place, so identity alone would never say so.
    [geometry, display, version, filter, draw, only, onlyVersion],
  );

  const graticuleData = useMemo(() => graticule(), []);

  const basemapData = useMemo(
    () =>
      ["a", "b", "c", "d"].map(
        (s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png`,
      ),
    [],
  );

  const boundaryData = useMemo(
    () =>
      boundaries.map((layer) => ({
        id: layer.id,
        data: {
          length: layer.pathCount,
          startIndices: layer.startIndices,
          attributes: { getPath: { value: layer.positions, size: 2 } },
        },
      })),
    [boundaries],
  );

  const layers = [
    // A real map underneath, because admin borders alone are not orientation:
    // zoom past a state line and there was nothing on screen to tell you where
    // you were. This is CARTO's dark basemap - coastlines, water, roads and
    // place names, drawn dark specifically to sit under data rather than
    // compete with it. No API key, and attribution is rendered below.
    new TileLayer({
      id: "basemap",
      data: basemapData,
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      // Never let the basemap eat a hover meant for a zone.
      pickable: false,
      renderSubLayers: (props) => {
        const { boundingBox } = props.tile;
        return new BitmapLayer(props, {
          data: undefined,
          image: props.data,
          bounds: [
            boundingBox[0][0],
            boundingBox[0][1],
            boundingBox[1][0],
            boundingBox[1][1],
          ],
        });
      },
    }),
    // Kept, but dimmer than it was: the basemap now carries the graticule's old
    // job of orientation of last resort, and two grids fight each other.
    new LineLayer({
      id: "graticule",
      data: graticuleData,
      getSourcePosition: (d) => d.from,
      getTargetPosition: (d) => d.to,
      getColor: [26, 32, 45, 120],
      getWidth: 1,
      pickable: false,
    }),
    // Under the played world, always. Loading terrain in a second pass once put
    // every grey dot on top of every coloured one; here the order is explicit
    // and cannot drift.
    new ScatterplotLayer({
      id: "terrain",
      data: terrainData,
      getRadius: 260,
      radiusUnits: "meters",
      radiusMinPixels: 0.6,
      radiusMaxPixels: 9,
      stroked: false,
      pickable: true,
      updateTriggers: { getFillColor: terrainData, getPosition: terrainData },
    }),
    new ScatterplotLayer({
      id: "zones",
      data: zoneData,
      radiusUnits: "meters",
      radiusMinPixels: 0.6,
      radiusMaxPixels: 9,
      stroked: false,
      pickable: true,
      // `filter` and `draw` belong here as much as `version` does. The loop
      // above rewrites `colors.current` and `radii.current` in place, and deck.gl
      // cannot see a mutation - only a changed trigger makes it re-upload. While
      // the `data` object was rebuilt inline on every render that re-upload
      // happened by accident on every render, which hid the omission; once it
      // was memoised, dimming an area stopped repainting the map at all.
      updateTriggers: {
        getFillColor: zoneData,
        getRadius: zoneData,
        getPosition: zoneData,
      },
    }),
    // Borders draw *over* the zones, not under them. Underneath, millions of
    // dots bury them exactly where the map is densest and a border is most
    // useful. They stay hairlines and semi-transparent so they read as an
    // overlay rather than cutting the data up.
    //
    // They also fade out as you zoom in. These rings are simplified to 0.01
    // degrees - about 1.1 km - which is invisible at world zoom and plainly
    // wrong at city zoom, where a coastline becomes a few straight lines cutting
    // across a bay. Past zoom 5 the basemap's own borders are both more accurate
    // and enough, so ours get out of the way.
    ...(boundaryAlpha > 0
      ? boundaryData.map(
          (layer) =>
            new PathLayer({
              id: `boundary-${layer.id}`,
              data: layer.data,
              _pathType: "open",
              // Country borders sit brighter than internal divisions so the
              // hierarchy still reads once both are over a dense field of dots.
              getColor:
                layer.id === "admin0"
                  ? [150, 168, 200, Math.round(205 * boundaryAlpha)]
                  : [104, 120, 150, Math.round(150 * boundaryAlpha)],
              getWidth: layer.id === "admin0" ? 1.1 : 0.7,
              widthUnits: "pixels",
              widthMinPixels: 0.5,
              pickable: false,
              updateTriggers: { getColor: boundaryAlpha },
              parameters: { depthTest: false },
            }),
        )
      : []),
  ];

  if (ring) {
    layers.push(
      new PathLayer({
        id: "range-ring",
        data: [circle(ring.lat, ring.lon, ring.radiusKm)],
        getPath: (d) => d,
        _pathType: "loop",
        getColor: [235, 240, 250, 130],
        getWidth: 1.4,
        widthUnits: "pixels",
        widthMinPixels: 1,
        pickable: false,
        parameters: { depthTest: false },
      }) as never,
    );
  }

  if (overlays?.length) layers.push(...(overlays as never[]));

  /**
   * The zone under the pointer, or null when nothing drawn is under it.
   *
   * deck.gl picks by geometry, and a dot hidden by a change window or by the
   * empty-zone toggle is still *there* - it is drawn at zero alpha and zero
   * radius, which the picking pass does not care about. Without this check the
   * panel confidently describes a zone the reader cannot see, which is worse
   * than describing nothing.
   */
  const picked = (info: PickingInfo): number | null => {
    if (info.index < 0) return null;
    // Both draw lists are compacted, so a pick index is a row in one of them
    // rather than a slot. Everything in either list passed its visibility test
    // when it was written, which is what makes this agree with what is on
    // screen by construction rather than by repeating the test and hoping the
    // two stay in step.
    if (info.layer?.id === "zones" && info.index < drawn.current) {
      return geometry.slotToIdx[drawnToSlot.current[info.index]];
    }
    if (info.layer?.id === "terrain" && info.index < terrain.current) {
      return geometry.slotToIdx[terrainToSlot.current[info.index]];
    }
    return null;
  };

  return (
    <DeckGL
      viewState={viewState}
      controller={{ dragRotate: false }}
      layers={layers}
      onHover={(info) => onHover(picked(info))}
      onClick={(info) => onClickZone(picked(info))}
      onViewStateChange={(e) => {
        const vs = e.viewState as MapViewState;
        onViewStateChange(vs);
        // Bounds are pushed to a callback that writes a ref rather than React
        // state: panning must not rebuild a 9.87M-event series every frame.
        const view = new WebMercatorViewport({
          ...vs,
          width: window.innerWidth,
          height: window.innerHeight,
        });
        const [west, south] = view.unproject([0, view.height]);
        const [east, north] = view.unproject([view.width, 0]);
        onBounds([west, south, east, north]);
      }}
      style={{ position: "absolute", inset: "0" }}
      getCursor={({ isDragging }) => (isDragging ? "grabbing" : "crosshair")}
    >
      {/* Required by the basemap's licence, not decoration. Kept small and
          dim, but it has to be on screen wherever those tiles are. */}
      <a
        href="https://carto.com/attributions"
        target="_blank"
        rel="noreferrer noopener"
        className="eyebrow"
        style={{
          position: "absolute",
          right: 8,
          bottom: 6,
          zIndex: 5,
          fontSize: 9,
          color: "var(--text-dim)",
          textDecoration: "none",
          background: "rgba(10,13,19,0.6)",
          padding: "2px 6px",
        }}
      >
        © OpenStreetMap · CARTO
      </a>
    </DeckGL>
  );
}
