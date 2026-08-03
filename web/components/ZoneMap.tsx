"use client";

import { useMemo, useRef } from "react";
import DeckGL from "@deck.gl/react";
import { ScatterplotLayer, PathLayer, LineLayer, PolygonLayer } from "@deck.gl/layers";
import { WebMercatorViewport, type MapViewState, type PickingInfo } from "@deck.gl/core";
import type { Bounds, Columns, ZoneState } from "@/lib/data";
import type { BoundaryLayer } from "@/lib/boundaries";

/** One aggregated tile at the current day, for the low-zoom view. */
export interface OverviewTile {
  key: string;
  bbox: Bounds;
  legion: number;
  swarm: number;
  faceless: number;
}

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

export interface ZoneMapProps {
  /** Null until the detail view needs them - 9.87 MB the world view never pays. */
  zones: Columns | null;
  state: ZoneState | null;
  version: number;
  detail: boolean;
  overview: OverviewTile[];
  boundaries: BoundaryLayer[];
  viewState: MapViewState;
  onViewStateChange: (next: MapViewState) => void;
  onHover: (info: PickingInfo) => void;
  onClickZone: (index: number | null) => void;
  onBounds: (bounds: Bounds) => void;
}

export function ZoneMap({
  zones,
  state,
  version,
  detail,
  overview,
  boundaries,
  viewState,
  onViewStateChange,
  onHover,
  onClickZone,
  onBounds,
}: ZoneMapProps) {
  const count = zones ? zones.latitude.length : 0;

  // Interleaved lon/lat, built once. Positions never change.
  const positions = useMemo(() => {
    const out = new Float32Array(count * 2);
    if (!zones) return out;
    const lat = zones.latitude as Float32Array;
    const lon = zones.longitude as Float32Array;
    for (let i = 0; i < count; i++) {
      out[i * 2] = lon[i];
      out[i * 2 + 1] = lat[i];
    }
    return out;
  }, [zones, count]);

  const colors = useRef(new Uint8Array(0));
  const radii = useRef(new Float32Array(0));
  if (colors.current.length !== count * 4) {
    colors.current = new Uint8Array(count * 4);
    radii.current = new Float32Array(count);
  }

  // Binary attributes rather than accessor functions. deck.gl calls an
  // accessor once per object per update, which is fine for 144k zones and
  // far too slow at 1.6M -- filling typed arrays directly keeps a global
  // scrub interactive.
  //
  // Filled during render, not in an effect: the layers below are constructed
  // from these same arrays, so an effect would populate them one frame after
  // deck.gl had already read them as zeroes.
  useMemo(() => {
    if (!state) return;
    const palette = readFactionColors();
    const colorArray = colors.current;
    const radiusArray = radii.current;

    for (let i = 0; i < count; i++) {
      // An empty zone is grey whoever nominally holds it: with no bots there
      // is nothing to own, and colouring it by faction overstates control.
      const total = state.total[i];
      const rgb = total > 0 ? (palette[state.faction[i]] ?? palette[0]) : palette[0];
      const o = i * 4;
      colorArray[o] = rgb[0];
      colorArray[o + 1] = rgb[1];
      colorArray[o + 2] = rgb[2];
      // Held zones read first, but empty ones stay clearly visible rather than
      // dropping out -- the map should show where zones exist, not only where
      // the fighting is.
      colorArray[o + 3] = total > 0 ? 215 : 105;
      // Counts span six orders of magnitude, so size is logarithmic and
      // capped in pixels. Colour carries who holds a zone; size stays quiet.
      radiusArray[i] = total > 0 ? 600 + Math.log10(total + 1) * 1400 : 400;
    }
  }, [state, count, version]);

  // Below the detail threshold the map draws one cell per tile from the
  // pre-aggregated series -- no zone positions, no checkpoints, no event
  // shards. A 16x16 grid of the world reads as a coarse choropleth, which is
  // an honest summary at a zoom where 1.6M individual dots would be sub-pixel
  // noise anyway.
  const overviewLayer = useMemo(() => {
    if (detail || !overview.length) return null;
    const palette = readFactionColors();
    // Normalised between the lightest and heaviest populated tile, not against
    // zero. Tile totals span 1e8 to 1e10, so a log ramp anchored at zero puts
    // every tile within 20% of the top and the whole grid reads as solid.
    let peak = 0;
    let floor = Infinity;
    for (const tile of overview) {
      const total = tile.legion + tile.swarm + tile.faceless;
      if (total <= 0) continue;
      if (total > peak) peak = total;
      if (total < floor) floor = total;
    }
    const low = Math.log10(floor + 1);
    const scale = Math.max(0.5, Math.log10(peak + 1) - low);

    return new PolygonLayer<OverviewTile>({
      id: "overview",
      data: overview,
      getPolygon: (d) => {
        const [w, s, e, n] = d.bbox;
        return [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
        ];
      },
      getFillColor: (d) => {
        const total = d.legion + d.swarm + d.faceless;
        if (total <= 0) return [...palette[0], 14] as [number, number, number, number];
        const leader =
          d.legion >= d.swarm && d.legion >= d.faceless ? 1 : d.swarm >= d.faceless ? 2 : 3;
        const weight = Math.min(1, Math.max(0, (Math.log10(total + 1) - low) / scale));
        // Capped well short of opaque so the coastlines drawn over the top
        // stay legible - the colour says who leads, the map says where.
        return [...palette[leader], 22 + weight * 120] as [number, number, number, number];
      },
      getLineColor: [70, 84, 110, 55],
      getLineWidth: 0.6,
      lineWidthUnits: "pixels",
      stroked: true,
      filled: true,
      pickable: true,
      updateTriggers: { getFillColor: version },
    });
  }, [detail, overview, version]);

  const layers = [
    new LineLayer({
      id: "graticule",
      data: graticule(),
      getSourcePosition: (d) => d.from,
      getTargetPosition: (d) => d.to,
      getColor: [26, 32, 45],
      getWidth: 1,
      pickable: false,
    }),
    // Tile fills sit under the coastlines: the grid is the data, the borders
    // are what makes it locatable.
    ...(overviewLayer ? [overviewLayer] : []),
    ...boundaries.map(
      (layer) =>
        new PathLayer({
          id: `boundary-${layer.id}`,
          data: {
            length: layer.pathCount,
            startIndices: layer.startIndices,
            attributes: { getPath: { value: layer.positions, size: 2 } },
          },
          _pathType: "open",
          // Hairlines, not terrain. Country borders sit a little brighter
          // than internal divisions so the hierarchy reads at world zoom.
          getColor: layer.id === "admin0" ? [70, 84, 110] : [44, 54, 74],
          getWidth: layer.id === "admin0" ? 1.2 : 0.8,
          widthUnits: "pixels",
          widthMinPixels: 0.6,
          pickable: false,
          parameters: { depthTest: false },
        }),
    ),
    ...(detail && zones && state
      ? [
          new ScatterplotLayer({
            id: "zones",
            data: {
              length: count,
              attributes: {
                getPosition: { value: positions, size: 2 },
                getFillColor: { value: colors.current, size: 4 },
                getRadius: { value: radii.current, size: 1 },
              },
            },
            radiusUnits: "meters",
            radiusMinPixels: 0.6,
            radiusMaxPixels: 9,
            stroked: false,
            pickable: true,
            updateTriggers: { getFillColor: version, getRadius: version },
          }),
        ]
      : []),
  ];

  return (
    <DeckGL
      viewState={viewState}
      controller={{ dragRotate: false }}
      layers={layers}
      onHover={onHover}
      onClick={(info) =>
        onClickZone(info.layer?.id === "zones" && info.index >= 0 ? info.index : null)
      }
      onViewStateChange={(e) => {
        const vs = e.viewState as MapViewState;
        onViewStateChange(vs);
        // Bounds are pushed to a ref rather than React state: panning must not
        // rebuild a 9.87M-event series on every frame.
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
    />
  );
}
