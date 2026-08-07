"use client";

import { useMemo, useRef } from "react";
import DeckGL from "@deck.gl/react";
import { ScatterplotLayer, PathLayer, LineLayer, BitmapLayer } from "@deck.gl/layers";
import { TileLayer } from "@deck.gl/geo-layers";
import { WebMercatorViewport, type MapViewState, type PickingInfo } from "@deck.gl/core";
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
  /** Draw zones holding no bots. Off by default; see WindowPicker. */
  uncapped: boolean;
  ring: RangeRing | null;
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
  uncapped,
  ring,
  onViewStateChange,
  onHover,
  onClickZone,
  onBounds,
}: ZoneMapProps) {
  const colors = useRef(new Uint8Array(geometry.size * 4));
  const radii = useRef(new Float32Array(geometry.size));

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
    const { slotToIdx, everActive, count } = geometry;

    for (let slot = 0; slot < count; slot++) {
      const idx = slotToIdx[slot];
      // One byte carries both facts, so this is one memory read per zone
      // rather than two - which matters when the loop runs 2.68M times on
      // every scrub.
      const pk = display.pk[idx];
      const magnitude = pk & 63;
      const o = slot * 4;

      // Empty zones answer to the toggle alone, never to the window. "This zone
      // holds nothing" is a fact about now, not about the span, so hiding an
      // empty zone because it did not happen to move this week would be
      // answering a question nobody asked. Zones that do hold something answer
      // to the window.
      //
      // Zero alpha and zero radius rather than a separate layer: the slot
      // buffers are already uploaded and deck.gl draws nothing for either.
      if (magnitude === 0 ? !uncapped : display.visible[idx] === 0) {
        colorArray[o + 3] = 0;
        radiusArray[slot] = 0;
        continue;
      }

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
        radiusArray[slot] = muted ? 300 : display.radius(magnitude);
      } else {
        // An empty zone is grey whoever nominally holds it: with no bots there
        // is nothing to own, and colouring it by faction overstates control.
        // Two shades of empty, because they mean different things - a zone
        // that has been fought over and emptied is part of the story, one that
        // has never been touched in fourteen years is just terrain.
        const played = everActive[idx] === 1;
        colorArray[o] = palette[0][0];
        colorArray[o + 1] = palette[0][1];
        colorArray[o + 2] = palette[0][2];
        colorArray[o + 3] = muted ? 12 : played ? 110 : 55;
        radiusArray[slot] = played ? 400 : 260;
      }
    }
  }, [geometry, display, version, filter, uncapped]);

  // Full strength out to zoom 5, gone by 7. Our rings are a world-scale
  // simplification; the basemap's borders take over as they stop being.
  const zoom = viewState.zoom ?? 0;
  const boundaryAlpha = Math.max(0, Math.min(1, (7 - zoom) / 2));

  const layers = [
    // A real map underneath, because admin borders alone are not orientation:
    // zoom past a state line and there was nothing on screen to tell you where
    // you were. This is CARTO's dark basemap - coastlines, water, roads and
    // place names, drawn dark specifically to sit under data rather than
    // compete with it. No API key, and attribution is rendered below.
    new TileLayer({
      id: "basemap",
      data: ["a", "b", "c", "d"].map(
        (s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png`,
      ),
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
      data: graticule(),
      getSourcePosition: (d) => d.from,
      getTargetPosition: (d) => d.to,
      getColor: [26, 32, 45, 120],
      getWidth: 1,
      pickable: false,
    }),
    new ScatterplotLayer({
      id: "zones",
      data: {
        length: geometry.count,
        attributes: {
          getPosition: { value: geometry.positions, size: 2 },
          getFillColor: { value: colors.current, size: 4 },
          getRadius: { value: radii.current, size: 1 },
        },
      },
      radiusUnits: "meters",
      radiusMinPixels: 0.6,
      radiusMaxPixels: 9,
      stroked: false,
      pickable: true,
      updateTriggers: { getFillColor: version, getRadius: version, getPosition: version },
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
      ? boundaries.map(
          (layer) =>
            new PathLayer({
              id: `boundary-${layer.id}`,
              data: {
                length: layer.pathCount,
                startIndices: layer.startIndices,
                attributes: { getPath: { value: layer.positions, size: 2 } },
              },
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
    if (info.layer?.id !== "zones" || info.index < 0) return null;
    const idx = geometry.slotToIdx[info.index];
    // Must mirror the draw test above exactly, or the panel describes a zone
    // that is not on screen.
    const empty = (display.pk[idx] & 63) === 0;
    return (empty ? !uncapped : display.visible[idx] === 0) ? null : idx;
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
