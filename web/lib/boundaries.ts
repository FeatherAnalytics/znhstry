/**
 * Admin boundary lines, packed as deck.gl binary paths.
 *
 * Layout is positions (float32 lon/lat pairs) followed by start indices
 * (uint32), with the point count in the manifest so the split is unambiguous.
 */

import { fetchBytes } from "./data";

export interface BoundaryLayer {
  id: string;
  positions: Float32Array;
  startIndices: Uint32Array;
  pathCount: number;
}

interface BoundaryManifest {
  source: string;
  layers: Record<string, { path: string; points: number; paths: number }>;
}

export async function loadBoundaries(base: string): Promise<BoundaryLayer[]> {
  const manifest: BoundaryManifest = await (await fetch(`${base}/boundaries.json`)).json();

  return Promise.all(
    Object.entries(manifest.layers).map(async ([id, entry]) => {
      // Brotli, unwrapped by the browser from Content-Encoding, like every
      // other payload - so this is a plain fetch with no decoding step.
      const buffer = await fetchBytes(`${base}/${entry.path}`);

      const positionBytes = entry.points * 2 * 4;
      return {
        id,
        positions: new Float32Array(buffer, 0, entry.points * 2),
        startIndices: new Uint32Array(buffer, positionBytes, entry.paths + 1),
        pathCount: entry.paths,
      };
    }),
  );
}
