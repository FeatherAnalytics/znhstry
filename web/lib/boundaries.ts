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

interface BoundaryEntry {
  path: string;
  points: number;
  paths: number;
  /** Province lines are 2.3 MB and only legible zoomed in, so they wait. */
  deferred: boolean;
}

interface BoundaryManifest {
  source: string;
  layers: Record<string, BoundaryEntry>;
}

async function loadLayer(base: string, id: string, entry: BoundaryEntry): Promise<BoundaryLayer> {
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
}

/**
 * Load the layers the manifest does not mark deferred.
 *
 * Country outlines orient the world view and are cheap; admin-1 covers every
 * country now rather than the nine the old line layer carried, which is what
 * makes it worth 2.3 MB - but only once someone has zoomed in far enough to
 * read a province.
 */
export async function loadBoundaries(base: string, deferred = false): Promise<BoundaryLayer[]> {
  const manifest: BoundaryManifest = await (await fetch(`${base}/boundaries.json`)).json();
  const wanted = Object.entries(manifest.layers).filter(
    ([, entry]) => Boolean(entry.deferred) === deferred,
  );
  return Promise.all(wanted.map(([id, entry]) => loadLayer(base, id, entry)));
}
