"""`_decode` has to be the exact inverse of `_pack`, and nothing else would say so.

The two live at opposite ends of the project - one writes the export, the other reads a
published one back into a warehouse - and they agree only by both following what
`meta.json` says. Every failure mode here is silent. Columns read at the wrong offset
still produce numbers in range; a delta column accumulated in its stored width wraps into
plausible coordinates; a truncated payload decodes however many rows arrived.

So the round trip is the test: pack real shapes, decode them, require the values back.
"""

from __future__ import annotations

import numpy as np
import pytest

from znhstry.export import COUNT, DAY, FACTION, IDX, _pack
from znhstry.hydrate import _decode


def test_a_multi_column_payload_round_trips():
    """The shape of a `zone_history/` block, which is the whole event stream."""
    data = {
        "idx": np.array([4, 4, 9, 4096], "int64"),
        "day": np.array([900, 901, 4000, 6000], "int64"),
        "control_state": np.array([0, 1, 2, 3], "int64"),
        "legion_count": np.array([0, 12, 0, 999_999], "int64"),
    }
    columns = {"idx": IDX, "day": DAY, "control_state": FACTION, "legion_count": COUNT}

    payload, spec, rows = _pack(data, columns, frozenset({"idx"}))
    decoded = _decode(payload, spec, rows)

    for name, values in data.items():
        assert decoded[name].tolist() == values.tolist(), name


def test_a_signed_delta_column_may_go_backwards():
    """Geometry tiles are in spatial order: longitude resets westward every row of
    latitude, so the deltas are negative and accumulating them in the stored width
    would wrap into a coordinate somewhere else entirely."""
    longitude = np.array([1_790_000, -1_780_000, 200_000], "int64")

    payload, spec, rows = _pack(
        {"longitude": longitude}, {"longitude": "int32"}, frozenset({"longitude"})
    )
    decoded = _decode(payload, spec, rows)

    assert decoded["longitude"].tolist() == longitude.tolist()


def test_a_truncated_payload_is_refused():
    payload, spec, rows = _pack({"day": np.array([900, 901], "int64")}, {"day": DAY})

    with pytest.raises(ValueError, match="expected 4 bytes"):
        _decode(payload[:-1], spec, rows)
