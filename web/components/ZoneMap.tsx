"use client";

import { useMemo } from "react";
import DeckGL from "@deck.gl/react";
import { ScatterplotLayer, LineLayer } from "@deck.gl/layers";
import type { MapViewState, PickingInfo } from "@deck.gl/core";
import type { Columns, ZoneState } from "@/lib/data";

// No basemap. 1.6 million zones draw the coastlines of human settlement by
// themselves, so the territory is the only geography on the page -- and the
// map avoids looking like every other deck.gl demo over Carto dark matter.
// A graticule gives back just enough orientation.
function graticule(step = 15) {
  const lines: { from: [number, number]; to: [number, number] }[] = [];
  for (let lon = -180; lon <= 180; lon += step) {
    lines.push({ from: [lon, -85], to: [lon, 85] });
  }
  for (let lat = -75; lat <= 75; lat += step) {
    lines.push({ from: [-180, lat], to: [180, lat] });
  }
  return lines;
}

const FACTION_VAR = ["--dormant", "--legion", "--swarm", "--faceless"] as const;

function readFactionColors(): [number, number, number][] {
  if (typeof window === "undefined") return [[74, 85, 104], [255, 77, 77], [34, 208, 126], [155, 109, 255]];
  const styles = getComputedStyle(document.documentElement);
  return FACTION_VAR.map((name) => {
    const hex = styles.getPropertyValue(name).trim();
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ] as [number, number, number];
  });
}

export interface ZoneMapProps {
  zones: Columns;
  state: ZoneState;
  version: number;
  viewState: MapViewState;
  onViewStateChange: (next: MapViewState) => void;
  onHover: (info: PickingInfo) => void;
  paletteKey: string;
}

export function ZoneMap({
  zones,
  state,
  version,
  viewState,
  onViewStateChange,
  onHover,
  paletteKey,
}: ZoneMapProps) {
  const colors = useMemo(() => readFactionColors(), [paletteKey]);
  const count = zones.latitude.length;

  const layers = [
    new LineLayer({
      id: "graticule",
      data: graticule(),
      getSourcePosition: (d) => d.from,
      getTargetPosition: (d) => d.to,
      getColor: [28, 34, 48],
      getWidth: 1,
      pickable: false,
    }),
    new ScatterplotLayer({
      id: "zones",
      data: { length: count },
      getPosition: (_: unknown, { index, target }: { index: number; target: number[] }) => {
        target[0] = (zones.longitude as Float32Array)[index];
        target[1] = (zones.latitude as Float32Array)[index];
        target[2] = 0;
        return target as [number, number, number];
      },
      getFillColor: (_: unknown, { index, target }: { index: number; target: number[] }) => {
        const rgb = colors[state.faction[index]] ?? colors[0];
        target[0] = rgb[0];
        target[1] = rgb[1];
        target[2] = rgb[2];
        // Zones holding nothing sit far back rather than vanishing, so the
        // shape of the map stays legible in quiet years.
        target[3] = state.total[index] > 0 ? 205 : 38;
        return target as [number, number, number, number];
      },
      // Colour carries who holds a zone; size is secondary and stays quiet.
      // Counts span six orders of magnitude, so this is a log scale with a
      // hard pixel ceiling -- a square-root scale let a few megazones cover
      // whole states and hid the shape of the map underneath.
      getRadius: (_: unknown, { index }: { index: number }) => {
        const total = state.total[index];
        return total > 0 ? 600 + Math.log10(total + 1) * 1400 : 400;
      },
      radiusUnits: "meters",
      radiusMinPixels: 0.6,
      radiusMaxPixels: 9,
      stroked: false,
      pickable: true,
      updateTriggers: {
        getFillColor: [version, paletteKey],
        getRadius: version,
      },
    }),
  ];

  return (
    <DeckGL
      viewState={viewState}
      controller={{ dragRotate: false }}
      onViewStateChange={(e) => onViewStateChange(e.viewState as MapViewState)}
      layers={layers}
      onHover={onHover}
      style={{ position: "absolute", inset: "0" }}
      getCursor={({ isDragging }) => (isDragging ? "grabbing" : "crosshair")}
    />
  );
}
