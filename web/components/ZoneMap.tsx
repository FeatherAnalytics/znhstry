"use client";

import { useMemo, useRef } from "react";
import DeckGL from "@deck.gl/react";
import { ScatterplotLayer, PathLayer, LineLayer } from "@deck.gl/layers";
import { WebMercatorViewport, type MapViewState, type PickingInfo } from "@deck.gl/core";
import type { Columns, ZoneState } from "@/lib/data";
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

export interface ZoneMapProps {
  zones: Columns;
  state: ZoneState;
  version: number;
  boundaries: BoundaryLayer[];
  viewState: MapViewState;
  onViewStateChange: (next: MapViewState) => void;
  onHover: (info: PickingInfo) => void;
  onClickZone: (index: number | null) => void;
  onBounds: (bounds: [number, number, number, number]) => void;
  paletteKey: string;
}

export function ZoneMap({
  zones,
  state,
  version,
  boundaries,
  viewState,
  onViewStateChange,
  onHover,
  onClickZone,
  onBounds,
  paletteKey,
}: ZoneMapProps) {
  const count = zones.latitude.length;

  // Interleaved lon/lat, built once. Positions never change.
  const positions = useMemo(() => {
    const out = new Float32Array(count * 2);
    const lat = zones.latitude as Float32Array;
    const lon = zones.longitude as Float32Array;
    for (let i = 0; i < count; i++) {
      out[i * 2] = lon[i];
      out[i * 2 + 1] = lat[i];
    }
    return out;
  }, [zones, count]);

  const colors = useRef(new Uint8Array(count * 4));
  const radii = useRef(new Float32Array(count));

  // Binary attributes rather than accessor functions. deck.gl calls an
  // accessor once per object per update, which is fine for 144k zones and
  // far too slow at 1.6M -- filling typed arrays directly keeps a global
  // scrub interactive.
  //
  // Filled during render, not in an effect: the layers below are constructed
  // from these same arrays, so an effect would populate them one frame after
  // deck.gl had already read them as zeroes.
  useMemo(() => {
    const palette = readFactionColors();
    const colorArray = colors.current;
    const radiusArray = radii.current;

    for (let i = 0; i < count; i++) {
      const rgb = palette[state.faction[i]] ?? palette[0];
      const o = i * 4;
      colorArray[o] = rgb[0];
      colorArray[o + 1] = rgb[1];
      colorArray[o + 2] = rgb[2];
      // Zones holding nothing sit far back rather than vanishing, so the
      // shape of the map stays legible in quiet years.
      const total = state.total[i];
      colorArray[o + 3] = total > 0 ? 205 : 34;
      // Counts span six orders of magnitude, so size is logarithmic and
      // capped in pixels. Colour carries who holds a zone; size stays quiet.
      radiusArray[i] = total > 0 ? 600 + Math.log10(total + 1) * 1400 : 400;
    }
  }, [state, count, version, paletteKey]);

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
      updateTriggers: { getFillColor: [version, paletteKey], getRadius: version },
    }),
  ];

  return (
    <DeckGL
      viewState={viewState}
      controller={{ dragRotate: false }}
      layers={layers}
      onHover={onHover}
      onClick={(info) => onClickZone(info.index >= 0 ? info.index : null)}
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
