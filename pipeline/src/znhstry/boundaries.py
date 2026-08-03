"""Admin boundary lines, packed for deck.gl's binary PathLayer.

Lines, not polygons. The zones themselves still draw the world -- these only
give back the orientation that a basemap would normally provide, as hairlines
dim enough to read as graticule rather than as terrain. Coastline is
deliberately not included: 1.6M zones already trace it, and drawing it twice
would say the land matters more than who holds it.

Natural Earth is public domain, so the packed output is committed rather than
fetched at runtime.
"""

from __future__ import annotations

import gzip
import json
import logging
from pathlib import Path
from typing import Any

import httpx
import numpy as np

from . import config

log = logging.getLogger(__name__)

SOURCE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"

LAYERS = {
    # Country borders read slightly brighter than internal divisions, so they
    # are separate layers rather than one merged path set.
    "admin0": "ne_50m_admin_0_boundary_lines_land",
    "admin1": "ne_50m_admin_1_states_provinces_lines",
}


def _fetch(name: str) -> dict[str, Any]:
    """Download once into data/raw so re-runs are offline and idempotent."""
    cache = config.RAW / "boundaries" / f"{name}.geojson"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))

    cache.parent.mkdir(parents=True, exist_ok=True)
    log.info("boundaries: downloading %s", name)
    response = httpx.get(f"{SOURCE}/{name}.geojson", timeout=120.0, follow_redirects=True)
    response.raise_for_status()
    cache.write_bytes(response.content)
    return response.json()


def _flatten(geojson: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    """GeoJSON lines -> (flat lon/lat positions, path start indices)."""
    positions: list[float] = []
    starts: list[int] = []

    for feature in geojson["features"]:
        geometry = feature.get("geometry") or {}
        kind = geometry.get("type")
        if kind == "LineString":
            parts = [geometry["coordinates"]]
        elif kind == "MultiLineString":
            parts = geometry["coordinates"]
        else:
            continue

        for line in parts:
            if len(line) < 2:
                continue
            starts.append(len(positions) // 2)
            for lon, lat in line:
                positions.append(lon)
                positions.append(lat)

    starts.append(len(positions) // 2)  # PathLayer needs the terminating index
    return (
        np.asarray(positions, dtype="float32"),
        np.asarray(starts, dtype="uint32"),
    )


def export_boundaries(out: Path | None = None) -> None:
    out = out or config.WEB_DATA
    out.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {"source": "Natural Earth 1:50m (public domain)", "layers": {}}

    for key, name in LAYERS.items():
        positions, starts = _flatten(_fetch(name))
        payload = positions.tobytes() + starts.tobytes()
        path = out / f"boundaries_{key}.bin.gz"
        path.write_bytes(gzip.compress(payload, 6))

        manifest["layers"][key] = {
            "path": path.name,
            "points": int(positions.size // 2),
            "paths": int(starts.size - 1),
            "bytes": path.stat().st_size,
        }
        log.info(
            "  %s: %s paths, %s points, %s KB",
            key,
            f"{starts.size - 1:,}",
            f"{positions.size // 2:,}",
            path.stat().st_size // 1024,
        )

    (out / "boundaries.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
