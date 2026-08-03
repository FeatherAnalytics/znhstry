/**
 * Admin boundary lines, packed as deck.gl binary paths.
 *
 * Layout is positions (float32 lon/lat pairs) followed by start indices
 * (uint32), with the point count in the manifest so the split is unambiguous.
 */

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
      const response = await fetch(`${base}/${entry.path}`);
      const buffer = await new Response(
        response.body!.pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer();

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
