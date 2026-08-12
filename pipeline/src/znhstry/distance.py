"""Great-circle distance between zones, and the things built directly on it.

Distance is about to be load-bearing in several unrelated places - ranking MAZ
clusters by how tight they are, asking what surrounds a zone, and the scope
filter the export has always had - so the formula lives here once instead of
being pasted a fourth time. `web/lib/series.ts` holds the browser's copy;
`EARTH_RADIUS_KM` is shared with it by having the same value, not by any
mechanism, so change both or neither.

Haversine rather than a geodesic on the ellipsoid. At these scales the
difference is about 0.3% - a few metres on a 1 km zone gap - and the coordinates
themselves are stored at 1e-4 degrees (~11 m), so a more expensive model would
be adding precision underneath the noise floor.

Two ways in, deliberately:

- Python, for a handful of points. Ranking 4,599 daily MAZ clusters is 21,000
  pairs and runs instantly.
- `haversine_sql`, for anything that touches the whole map. 2.68M zones belong
  in DuckDB, and pulling them into Python to measure them would be the slow way
  round.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

from . import config

# 111.32 km/degree of latitude is a mid-latitude average and a real degree is
# shorter than that nearer the equator, so a box built from it is *narrower*
# than the circle it stands in for and silently clips edge members. A bbox here
# is only ever an indexable prefilter with haversine deciding membership behind
# it, so it must be unambiguously generous.
BBOX_MARGIN = 1.05

_KM_PER_DEGREE_LAT = 111.32


def haversine_km(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    """Great-circle kilometres between two points."""
    d_lat = math.radians(b_lat - a_lat)
    d_lon = math.radians(b_lon - a_lon)
    h = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(a_lat)) * math.cos(math.radians(b_lat)) * math.sin(d_lon / 2) ** 2
    )
    # Rounding can push h a hair over 1 for antipodal points, and asin would
    # then raise on a pair of perfectly valid coordinates.
    return 2 * config.EARTH_RADIUS_KM * math.asin(math.sqrt(min(1.0, h)))


def haversine_km_array(
    a_lat: np.ndarray,
    a_lon: np.ndarray,
    b_lat: np.ndarray,
    b_lon: np.ndarray,
) -> np.ndarray:
    """`haversine_km` over numpy arrays, with normal broadcasting rules.

    Shape the inputs to pick the comparison: `(n, 1)` against `(1, n)` gives the
    full pairwise matrix, `(n,)` against a scalar gives one origin to many.
    """
    a_lat_r, b_lat_r = np.radians(a_lat), np.radians(b_lat)
    d_lat = b_lat_r - a_lat_r
    d_lon = np.radians(b_lon) - np.radians(a_lon)
    h = np.sin(d_lat / 2) ** 2 + np.cos(a_lat_r) * np.cos(b_lat_r) * np.sin(d_lon / 2) ** 2
    return 2 * config.EARTH_RADIUS_KM * np.arcsin(np.sqrt(np.minimum(1.0, h)))


def haversine_sql(a_lat: str, a_lon: str, b_lat: str, b_lon: str) -> str:
    """The same formula as a SQL expression, in kilometres.

    Arguments are SQL fragments - a column name, a literal, anything that
    evaluates to a number - so both sides can be columns for a pairwise join or
    one side can be a fixed point.
    """
    return f"""
        {config.EARTH_RADIUS_KM} * 2 * asin(sqrt(least(1.0,
            pow(sin(radians(({b_lat}) - ({a_lat})) / 2), 2)
            + cos(radians({a_lat})) * cos(radians({b_lat}))
              * pow(sin(radians(({b_lon}) - ({a_lon})) / 2), 2)
        )))
    """.strip()


def bbox(lat: float, lon: float, radius_km: float) -> tuple[float, float, float, float]:
    """Indexable prefilter around a circle, as `(lat_min, lat_max, lon_min, lon_max)`.

    Deliberately over-wide - see `BBOX_MARGIN`. Never use it as the filter
    itself.
    """
    lat_delta = BBOX_MARGIN * radius_km / _KM_PER_DEGREE_LAT
    # Degrees of longitude collapse towards the poles, so the box widens until
    # it wraps the world. Without the cap, a circle near either pole divides by
    # a cosine approaching zero.
    scale = math.cos(math.radians(min(abs(lat) + lat_delta, 89.9)))
    lon_delta = min(180.0, BBOX_MARGIN * radius_km / (_KM_PER_DEGREE_LAT * scale))
    return (
        max(lat - lat_delta, -90.0),
        min(lat + lat_delta, 90.0),
        lon - lon_delta,
        lon + lon_delta,
    )


def circle_sql(
    lat: float,
    lon: float,
    radius_km: float,
    lat_col: str = "latitude",
    lon_col: str = "longitude",
) -> str:
    """A complete `where` clause for zones within `radius_km` of a point.

    The bbox prefilter and the haversine test together, because emitting one
    without the other is the mistake worth designing out: the bbox alone is
    wrong, and the haversine alone reads every row.
    """
    lat_min, lat_max, lon_min, lon_max = bbox(lat, lon, radius_km)
    return (
        f"{lat_col} between {lat_min} and {lat_max}"
        f" and {lon_col} between {lon_min} and {lon_max}"
        f" and {haversine_sql(str(lat), str(lon), lat_col, lon_col)} <= {radius_km}"
    )


@dataclass(frozen=True)
class Spread:
    """How tightly a set of points sits together, in kilometres."""

    count: int
    diameter_km: float
    """The farthest pair. What "how big is this cluster" means."""
    mean_pair_km: float
    """Average over all pairs. Separates a tight knot from a knot plus an outlier."""
    closest_pair_km: float
    """The nearest pair. Small in almost any cluster, so it describes a pair rather
    than the group - do not rank clusters by it."""


def spread(points: Sequence[tuple[float, float]]) -> Spread:
    """Pairwise spread of `(lat, lon)` points.

    Raises on fewer than two points rather than returning zeros. A single point
    has no pairs, and a zero would sort to the top of exactly the "which cluster
    is tightest" ranking this exists to serve.
    """
    if len(points) < 2:
        raise ValueError(f"spread needs at least two points, got {len(points)}")

    lat = np.array([p[0] for p in points], dtype=np.float64)
    lon = np.array([p[1] for p in points], dtype=np.float64)
    matrix = haversine_km_array(lat[:, None], lon[:, None], lat[None, :], lon[None, :])

    # Every pair once: the matrix is symmetric with a zero diagonal, and
    # including either would drag the mean towards zero.
    pairs = matrix[np.triu_indices(len(points), k=1)]
    return Spread(
        count=len(points),
        diameter_km=float(pairs.max()),
        mean_pair_km=float(pairs.mean()),
        closest_pair_km=float(pairs.min()),
    )


def cluster(
    points: Sequence[tuple[Any, float, float]],
    *,
    within_km: float = config.NEIGHBORHOOD_KM,
) -> list[list[Any]]:
    """Group `(key, lat, lon)` points into neighborhoods, biggest group first.

    Single linkage: two points are in the same group when they are within
    `within_km` of each other, and that relation is transitive. Returns the keys,
    not the points, so a caller can look up whatever else it holds about them -
    and can hand the same keys to `spread` to measure what came back.

    **Single linkage chains, and that is a feature here rather than a flaw to
    tune away.** A row of zones each 40 km from the next is one front, and a
    grouping that split it at an arbitrary diameter would be answering a
    different question. It does mean a group's diameter can exceed `within_km`
    several times over, so **rank groups by `spread`, never by the cutoff** - the
    cutoff says what counts as adjacent, not how big a neighborhood may be.

    Ordered by size then by first appearance, so the caller sees the day's main
    event first and the ordering does not depend on dictionary iteration.
    Singletons come back as one-element groups rather than being dropped: a zone
    fighting alone is a real answer to "how concentrated was this day", and
    silently removing it would make the group count disagree with the input.

    O(n^2) in the number of points, which is the right trade for the ten to
    thirty a MAZ day carries. It is not the way to cluster 2.68M zones.
    """
    n = len(points)
    if n == 0:
        return []

    lat = np.array([p[1] for p in points], dtype=np.float64)
    lon = np.array([p[2] for p in points], dtype=np.float64)
    matrix = haversine_km_array(lat[:, None], lon[:, None], lat[None, :], lon[None, :])

    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            if matrix[i, j] <= within_km:
                a, b = find(i), find(j)
                if a != b:
                    parent[b] = a

    groups: dict[int, list[Any]] = {}
    first: dict[int, int] = {}
    for i in range(n):
        root = find(i)
        groups.setdefault(root, []).append(points[i][0])
        first.setdefault(root, i)

    # Size first, then the position of the group's first member, so two groups of
    # equal size come back in the order they were given rather than by root id -
    # which is an implementation detail and would make the output unstable.
    return [
        group
        for _, group in sorted(
            ((root, group) for root, group in groups.items()),
            key=lambda item: (-len(item[1]), first[item[0]]),
        )
    ]


@dataclass(frozen=True)
class Neighbor:
    key: Any
    km: float


def nearest(
    lat: float,
    lon: float,
    candidates: Iterable[tuple[Any, float, float]],
    *,
    k: int | None = None,
    within_km: float | None = None,
) -> list[Neighbor]:
    """The candidates closest to a point, nearest first.

    `candidates` are `(key, lat, lon)`; the key is passed through untouched, so
    it can be a zone id, an index, or a whole row. `k` caps the result and
    `within_km` bounds the search - give at least one for a large set.

    A point at the origin's own coordinates is returned like any other. Drop the
    zone itself from `candidates` if that is not wanted, since only the caller
    knows whether the origin is one of them.
    """
    keys: list[Any] = []
    lats: list[float] = []
    lons: list[float] = []

    if within_km is not None:
        lat_min, lat_max, lon_min, lon_max = bbox(lat, lon, within_km)

    for key, c_lat, c_lon in candidates:
        # Reject on the box before doing any trigonometry. On a nationwide
        # candidate set this discards most rows for the cost of four
        # comparisons.
        if within_km is not None and not (
            lat_min <= c_lat <= lat_max and lon_min <= c_lon <= lon_max
        ):
            continue
        keys.append(key)
        lats.append(c_lat)
        lons.append(c_lon)

    if not keys:
        return []

    km = haversine_km_array(
        np.float64(lat), np.float64(lon), np.array(lats), np.array(lons)
    )

    if within_km is not None:
        inside = km <= within_km
        km = km[inside]
        keys = [key for key, keep in zip(keys, inside, strict=True) if keep]
        if not keys:
            return []

    order = np.argsort(km, kind="stable")
    if k is not None:
        order = order[:k]
    return [Neighbor(key=keys[i], km=float(km[i])) for i in order]
