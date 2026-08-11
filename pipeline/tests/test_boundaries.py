"""Path offsets into the flattened boundary buffer.

deck.gl's binary PathLayer reads one flat run of positions plus the index each path
starts at. An offset that is off by a single point does not draw one wrong line - it
re-cuts every path after it, so the borders wander across the continent and no part of
the output looks obviously broken.
"""

from __future__ import annotations

from typing import Any

from znhstry.boundaries import _flatten


def _polygon(*rings: list[list[float]]) -> dict[str, Any]:
    return {"geometry": {"type": "Polygon", "coordinates": list(rings)}}


# Tolerance 0 keeps every point, so the offsets are the only thing under test.
_A = [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]]
_B = [[0.0, 1.0], [1.0, 1.0]]
_C = [[0.0, 2.0], [1.0, 2.0], [2.0, 2.0], [3.0, 2.0]]


def test_each_path_starts_where_the_last_one_ended():
    flat, starts, dropped = _flatten({"features": [_polygon(_A, _B), _polygon(_C)]}, 0.0)

    assert list(starts) == [0, 3, 5, 9]  # the last is PathLayer's terminating index
    assert flat.size == 18  # nine points, two floats each
    assert dropped == 0


def test_a_ring_too_short_to_draw_leaves_no_gap_behind_it():
    """A skipped ring must not advance the offsets, or every path after it shifts."""
    _, starts, _ = _flatten({"features": [_polygon(_A, [[9.0, 9.0]], _C)]}, 0.0)

    assert list(starts) == [0, 3, 7]
