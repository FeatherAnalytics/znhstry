"""Admin boundary lines, packed for deck.gl's binary PathLayer.

Derived from Natural Earth **polygons**, not from its boundary-line layers.
That is the whole point of this module's shape:

- `ne_50m_admin_0_boundary_lines_land` covers land borders only, so every
  island nation - the UK, Japan, Indonesia, the Caribbean, New Zealand - had
  no outline at all.
- `ne_50m_admin_1_states_provinces_lines` carries 581 features spanning
  **9 countries**. Province lines existed for a handful of places and nowhere
  else, which is what made the map look arbitrary.

Tracing polygon rings instead gives complete, consistent coverage: 242
countries at admin-0 and 251 at admin-1. It also draws coastlines, which the
line layers omitted -- worth having, because the low-zoom tile grid needs
something recognisable underneath it.

Rings are simplified with Douglas-Peucker before packing. At 10m resolution
the admin-1 set is 1.3M points; at a 0.01 degree tolerance (~1.1 km) it is
382k, which is still far more detailed than the 50m data it replaces.

Natural Earth is public domain, so the packed output is committed rather than
fetched at runtime.
"""

from __future__ import annotations

import gzip
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import numpy as np

from . import config

log = logging.getLogger(__name__)

SOURCE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"

# Roughly 1.1 km. Invisible against boundaries this generalised, and it cuts
# the admin-1 set by 70%.
SIMPLIFY_TOLERANCE = 0.01


@dataclass(frozen=True)
class Layer:
    source: str
    #: Loaded with the page, or only once the detail view needs it. Country
    #: outlines orient the world view; province lines only matter zoomed in,
    #: and at 2.3 MB they would otherwise more than double first paint.
    deferred: bool


LAYERS = {
    "admin0": Layer("ne_50m_admin_0_countries", deferred=False),
    "admin1": Layer("ne_10m_admin_1_states_provinces", deferred=True),
}


def _fetch(name: str) -> dict[str, Any]:
    """Download once into data/raw so re-runs are offline and idempotent."""
    cache = config.RAW / "boundaries" / f"{name}.geojson"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))

    cache.parent.mkdir(parents=True, exist_ok=True)
    log.info("boundaries: downloading %s", name)
    response = httpx.get(f"{SOURCE}/{name}.geojson", timeout=300.0, follow_redirects=True)
    response.raise_for_status()
    cache.write_bytes(response.content)
    return response.json()


def _rings(geometry: dict[str, Any]) -> list[list[list[float]]]:
    """Every ring or line in a geometry, whatever its type."""
    kind, coordinates = geometry.get("type"), geometry.get("coordinates")
    if kind == "Polygon":
        return list(coordinates)
    if kind == "MultiPolygon":
        return [ring for polygon in coordinates for ring in polygon]
    if kind == "LineString":
        return [coordinates]
    if kind == "MultiLineString":
        return list(coordinates)
    return []


def _simplify(points: np.ndarray, tolerance: float) -> np.ndarray:
    """Douglas-Peucker, iterative so a 40k-point ring cannot blow the stack.

    Perpendicular distance in degrees rather than metres. Boundaries are
    drawn as hairlines over a whole continent, so the anisotropy of a degree
    away from the equator does not show.
    """
    n = len(points)
    if n < 3 or tolerance <= 0:
        return points

    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]

    while stack:
        start, end = stack.pop()
        if end <= start + 1:
            continue
        segment = points[end] - points[start]
        length_sq = float(segment @ segment)
        offsets = points[start + 1 : end] - points[start]
        if length_sq == 0:
            distance = np.hypot(offsets[:, 0], offsets[:, 1])
        else:
            t = np.clip((offsets @ segment) / length_sq, 0.0, 1.0)
            distance = np.hypot(*(offsets - np.outer(t, segment)).T)
        furthest = int(np.argmax(distance))
        if distance[furthest] > tolerance:
            split = start + 1 + furthest
            keep[split] = True
            stack.append((start, split))
            stack.append((split, end))

    return points[keep]


def _flatten(geojson: dict[str, Any], tolerance: float) -> tuple[np.ndarray, np.ndarray, int]:
    """GeoJSON -> (flat lon/lat positions, path start indices, points dropped)."""
    positions: list[np.ndarray] = []
    starts: list[int] = []
    total = 0
    kept = 0

    for feature in geojson["features"]:
        for ring in _rings(feature.get("geometry") or {}):
            if len(ring) < 2:
                continue
            points = np.asarray([point[:2] for point in ring], dtype="float64")
            total += len(points)
            points = _simplify(points, tolerance)
            if len(points) < 2:
                continue
            kept += len(points)
            starts.append(sum(len(p) for p in positions))
            positions.append(points)

    flat = (
        np.concatenate(positions).astype("float32").ravel()
        if positions
        else np.zeros(0, dtype="float32")
    )
    starts.append(flat.size // 2)  # PathLayer needs the terminating index
    return flat, np.asarray(starts, dtype="uint32"), total - kept


def export_boundaries(out: Path | None = None) -> None:
    out = out or config.WEB_DATA
    out.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {
        "source": "Natural Earth (public domain), polygon rings traced as lines",
        "simplify_tolerance_deg": SIMPLIFY_TOLERANCE,
        "layers": {},
    }

    for key, layer in LAYERS.items():
        positions, starts, dropped = _flatten(_fetch(layer.source), SIMPLIFY_TOLERANCE)
        payload = positions.tobytes() + starts.tobytes()
        path = out / f"boundaries_{key}.bin.gz"
        path.write_bytes(gzip.compress(payload, 6))

        manifest["layers"][key] = {
            "path": path.name,
            "source": layer.source,
            "points": int(positions.size // 2),
            "paths": int(starts.size - 1),
            "bytes": path.stat().st_size,
            "deferred": layer.deferred,
        }
        log.info(
            "  %s: %s paths, %s points (%s simplified away), %s KB%s",
            key,
            f"{starts.size - 1:,}",
            f"{positions.size // 2:,}",
            f"{dropped:,}",
            path.stat().st_size // 1024,
            " [deferred]" if layer.deferred else "",
        )

    (out / "boundaries.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
