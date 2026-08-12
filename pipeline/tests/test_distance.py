"""Three implementations of one formula have to agree, and a bbox has to be generous.

`distance` carries the haversine in Python, in numpy and in SQL, because the callers
live in different places - a cluster ranking, the whole 2.68M-zone map, and the export's
scope filter. Three copies is two chances to drift, and a drift here is quiet: every
answer stays a plausible number of kilometres.

The bbox has a sharper failure. It is only ever a prefilter, so being slightly too small
does not raise anything - it removes edge zones from the result and nothing says so. That
already happened once, to 11 zones on a 1000-mile scope.
"""

from __future__ import annotations

import math

import duckdb
import numpy as np
import pytest

from znhstry import config, distance

# Along a meridian the great-circle distance has a closed form - R times the
# angle - so these check the formula against arithmetic rather than against
# another copy of itself.
KM_PER_DEGREE = config.EARTH_RADIUS_KM * math.pi / 180


def test_meridian_and_equator_match_the_closed_form() -> None:
    assert distance.haversine_km(0, 0, 1, 0) == pytest.approx(KM_PER_DEGREE)
    assert distance.haversine_km(51, 0, 52, 0) == pytest.approx(KM_PER_DEGREE)
    # Only on the equator is a degree of longitude the same length.
    assert distance.haversine_km(0, 0, 0, 1) == pytest.approx(KM_PER_DEGREE)
    assert distance.haversine_km(0, 0, 90, 0) == pytest.approx(
        config.EARTH_RADIUS_KM * math.pi / 2
    )


def test_a_degree_of_longitude_shortens_with_latitude() -> None:
    """The reason a bbox needs a margin, stated as a test."""
    assert distance.haversine_km(60, 0, 60, 1) == pytest.approx(
        KM_PER_DEGREE * math.cos(math.radians(60)), rel=1e-3
    )


def test_identical_and_antipodal_points_do_not_raise() -> None:
    assert distance.haversine_km(51.2451, 1.1264, 51.2451, 1.1264) == 0.0
    # Rounding can push the haversine term a hair over 1 here, and an unclamped
    # asin raises on a pair of perfectly valid coordinates.
    assert distance.haversine_km(0, 0, 0, 180) == pytest.approx(
        config.EARTH_RADIUS_KM * math.pi
    )
    assert distance.haversine_km(-90, 0, 90, 0) == pytest.approx(
        config.EARTH_RADIUS_KM * math.pi
    )


def test_distance_is_symmetric() -> None:
    a, b = (51.3607, 1.0257), (51.2254, 1.20157)
    assert distance.haversine_km(*a, *b) == pytest.approx(distance.haversine_km(*b, *a))


# --- the three implementations ------------------------------------------------

POINTS = [
    (51.3607, 1.0257),  # Whitstable
    (51.2254, 1.20157),  # Aylesham
    (32.7767, -96.7970),  # Dallas
    (-34.9285, 138.6007),  # Adelaide
    (0.0, 0.0),
    (89.9, 179.9),
]


def test_numpy_agrees_with_scalar() -> None:
    lat = np.array([p[0] for p in POINTS])
    lon = np.array([p[1] for p in POINTS])
    matrix = distance.haversine_km_array(lat[:, None], lon[:, None], lat[None, :], lon[None, :])

    for i, a in enumerate(POINTS):
        for j, b in enumerate(POINTS):
            assert matrix[i][j] == pytest.approx(distance.haversine_km(*a, *b))


def test_sql_agrees_with_python() -> None:
    """The copy the export runs, checked against the copy everything else calls."""
    con = duckdb.connect()
    expression = distance.haversine_sql("a_lat", "a_lon", "b_lat", "b_lon")
    for a in POINTS:
        for b in POINTS:
            (km,) = con.execute(
                f"select {expression} from (select ? a_lat, ? a_lon, ? b_lat, ? b_lon)",
                [a[0], a[1], b[0], b[1]],
            ).fetchone()
            assert km == pytest.approx(distance.haversine_km(*a, *b))
    con.close()


# --- the bbox must never be tighter than its circle ---------------------------


@pytest.mark.parametrize("lat", [0, 23.5, 51.3, -34.9, 71.0, 89.5, -89.5])
@pytest.mark.parametrize("radius_km", [1, 30, 250, 1609])
def test_bbox_contains_every_point_on_the_circle(lat: float, radius_km: float) -> None:
    """Walk the circle and check the box holds all of it. This is the invariant."""
    lon = 12.0
    lat_min, lat_max, lon_min, lon_max = distance.bbox(lat, lon, radius_km)

    for bearing in range(0, 360, 5):
        theta = math.radians(bearing)
        angular = radius_km / config.EARTH_RADIUS_KM
        edge_lat = math.degrees(
            math.asin(
                math.sin(math.radians(lat)) * math.cos(angular)
                + math.cos(math.radians(lat)) * math.sin(angular) * math.cos(theta)
            )
        )
        edge_lon = lon + math.degrees(
            math.atan2(
                math.sin(theta) * math.sin(angular) * math.cos(math.radians(lat)),
                math.cos(angular) - math.sin(math.radians(lat)) * math.sin(math.radians(edge_lat)),
            )
        )
        assert lat_min <= edge_lat <= lat_max
        assert lon_min <= edge_lon <= lon_max


def test_bbox_near_the_pole_does_not_divide_by_zero() -> None:
    """Degrees of longitude collapse to nothing at the pole; the box wraps instead."""
    _, _, lon_min, lon_max = distance.bbox(90.0, 0.0, 100.0)
    assert lon_max - lon_min == pytest.approx(360.0)


def test_circle_sql_selects_the_same_zones_as_python() -> None:
    con = duckdb.connect()
    rng = np.random.default_rng(0)
    lats = rng.uniform(-80, 80, 2000)
    lons = rng.uniform(-180, 180, 2000)
    con.execute("create table z as select * from (select unnest(?) latitude, unnest(?) longitude)",
                [list(lats), list(lons)])

    origin_lat, origin_lon, radius = 51.3, 1.0, 900.0
    where = distance.circle_sql(origin_lat, origin_lon, radius)
    rows = con.execute(f"select latitude, longitude from z where {where}").fetchall()
    con.close()

    expected = {
        (lat, lon)
        for lat, lon in zip(lats, lons, strict=True)
        if distance.haversine_km(origin_lat, origin_lon, lat, lon) <= radius
    }
    assert {(lat, lon) for lat, lon in rows} == expected
    assert expected, "the fixture should contain some zones inside the circle"


# --- spread -------------------------------------------------------------------


def test_spread_of_a_known_cluster() -> None:
    """The Whitstable/Canterbury pair of knots from 2019-06-11, the only n=6 MAZ day."""
    kent = [
        (51.2254, 1.20157),  # Aylesham
        (51.2559, 1.13713),  # Bekesbourne
        (51.3, 1.05),  # Blean
        (51.2451, 1.1264),  # Bridge
        (51.3615, 1.04629),  # Tankerton
        (51.3607, 1.0257),  # Whitstable
    ]
    result = distance.spread(kent)

    assert result.count == 6
    assert result.diameter_km == pytest.approx(19.4, abs=0.1)
    assert result.mean_pair_km == pytest.approx(10.1, abs=0.1)
    # Bridge to Bekesbourne, just ahead of Whitstable to Tankerton at 1.43.
    assert result.closest_pair_km == pytest.approx(1.414, abs=0.01)


def test_spread_counts_each_pair_once() -> None:
    """A symmetric matrix with a zero diagonal would halve the mean if included."""
    points = [(0.0, 0.0), (0.0, 1.0), (0.0, 3.0)]
    result = distance.spread(points)

    assert result.diameter_km == pytest.approx(3 * KM_PER_DEGREE)
    assert result.closest_pair_km == pytest.approx(KM_PER_DEGREE)
    # (1 + 3 + 2) / 3 degrees, not divided by nine cells.
    assert result.mean_pair_km == pytest.approx(2 * KM_PER_DEGREE)


@pytest.mark.parametrize("points", [[], [(51.0, 1.0)]])
def test_spread_refuses_fewer_than_two_points(points: list) -> None:
    """Zero would sort to the top of the tightest-cluster ranking this exists for."""
    with pytest.raises(ValueError):
        distance.spread(points)


# --- nearest ------------------------------------------------------------------

CANDIDATES = [
    ("whitstable", 51.3607, 1.0257),
    ("tankerton", 51.3615, 1.04629),
    ("blean", 51.3, 1.05),
    ("bridge", 51.2451, 1.1264),
    ("dallas", 32.7767, -96.7970),
]


def test_nearest_orders_by_distance_and_honours_k() -> None:
    found = distance.nearest(51.3607, 1.0257, CANDIDATES, k=3)

    assert [n.key for n in found] == ["whitstable", "tankerton", "blean"]
    assert found[0].km == 0.0
    assert found[1].km < found[2].km


def test_nearest_within_km_excludes_the_far_side_of_the_world() -> None:
    found = distance.nearest(51.3607, 1.0257, CANDIDATES, within_km=10)

    assert [n.key for n in found] == ["whitstable", "tankerton", "blean"]
    assert all(n.km <= 10 for n in found)


def test_nearest_bbox_prefilter_keeps_points_just_inside_the_radius() -> None:
    """The prefilter runs before any trigonometry, so an edge point must survive it."""
    origin = (51.3607, 1.0257)
    # Due east, well inside the radius but far out along the axis the box is
    # widest - the case an unpadded box clips.
    east = (origin[0], origin[1] + 0.4)
    km = distance.haversine_km(*origin, *east)

    found = distance.nearest(*origin, [("east", *east)], within_km=km + 0.001)
    assert [n.key for n in found] == ["east"]


def test_nearest_returns_nothing_rather_than_raising_on_an_empty_set() -> None:
    assert distance.nearest(51.0, 1.0, [], within_km=10) == []
    assert distance.nearest(51.0, 1.0, CANDIDATES, within_km=0.0001) == []


# --- cluster ------------------------------------------------------------------

# The 2019-06-11 Kent day, the only time six of the world's ten most active zones
# sat in one region, plus a Dallas zone that has no business joining them.
KENT = [
    ("aylesham", 51.2287, 1.2044),
    ("bekesbourne", 51.2668, 1.1358),
    ("blean", 51.3, 1.05),
    ("bridge", 51.2451, 1.1264),
    ("tankerton", 51.3615, 1.04629),
    ("whitstable", 51.3607, 1.0257),
]


def test_cluster_finds_the_kent_knot_and_leaves_dallas_out() -> None:
    groups = distance.cluster([*KENT, ("dallas", 32.7767, -96.7970)])

    assert len(groups) == 2
    assert sorted(groups[0]) == sorted(k for k, _, _ in KENT)
    assert groups[1] == ["dallas"]


def test_cluster_orders_by_size_then_by_first_appearance() -> None:
    """Two groups of equal size must come back in input order, not root order."""
    points = [
        ("a1", 0.0, 0.0),
        ("b1", 40.0, 0.0),
        ("a2", 0.0, 0.1),
        ("b2", 40.0, 0.1),
    ]
    groups = distance.cluster(points, within_km=50)

    assert groups == [["a1", "a2"], ["b1", "b2"]]


def test_cluster_chains_through_intermediate_points() -> None:
    """Single linkage joins A to C through B even when A and C are far apart.

    Documented behaviour rather than an accident: a row of zones each within the
    cutoff of the next is one front. It is also why a group's diameter has to be
    measured with `spread` instead of assumed from the cutoff.
    """
    chain = [("a", 0.0, 0.0), ("b", 0.0, 0.3), ("c", 0.0, 0.6), ("d", 0.0, 0.9)]
    groups = distance.cluster(chain, within_km=40)

    assert groups == [["a", "b", "c", "d"]]
    assert distance.spread([(0.0, 0.0), (0.0, 0.9)]).diameter_km > 40


def test_cluster_splits_when_nothing_is_within_the_cutoff() -> None:
    groups = distance.cluster(KENT, within_km=0.5)

    assert len(groups) == len(KENT)
    assert all(len(g) == 1 for g in groups)


def test_cluster_keeps_every_input_exactly_once() -> None:
    """A dropped singleton would make the group count disagree with the input."""
    points = [*KENT, ("dallas", 32.7767, -96.7970), ("sydney", -33.86, 151.20)]
    groups = distance.cluster(points)

    flat = [key for group in groups for key in group]
    assert sorted(flat) == sorted(k for k, _, _ in points)


def test_cluster_of_nothing_is_nothing() -> None:
    assert distance.cluster([]) == []
    assert distance.cluster([("only", 51.0, 1.0)]) == [["only"]]


def test_cluster_default_cutoff_is_the_shared_neighborhood_constant() -> None:
    """The link cutoff and the map's framing margin are deliberately one value."""
    assert distance.cluster(KENT) == distance.cluster(KENT, within_km=config.NEIGHBORHOOD_KM)
