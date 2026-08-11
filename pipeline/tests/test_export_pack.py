"""What `_pack` refuses to write.

Every payload in the export is a fixed-width columnar dump: there is no room in it for
a null and no signal in it for an overflow. A value one step past the column's width
lands as a plausible small number and a null lands as a zero, so neither shows up in
the file, in the manifest, or on the map - a zone is simply somewhere else, or empty,
or in a country it has never been near.

That is why the guards live here rather than in whichever query happened to be wrong:
this is the last point where the real value still exists.
"""

from __future__ import annotations

import numpy as np
import pytest

from znhstry.export import COUNT, DAY, IDX, _pack


def test_columns_are_written_back_to_back_in_the_order_the_manifest_lists():
    payload, spec, rows = _pack(
        {"idx": np.array([0, 1], "int64"), "pk": np.array([7, 9], "int64")},
        {"idx": IDX, "pk": "uint8"},
    )

    assert rows == 2
    assert [name for name, _, _ in spec] == ["idx", "pk"]
    assert payload == np.array([0, 1], "uint32").tobytes() + bytes([7, 9])


def test_a_day_before_the_epoch_is_refused():
    """It would underflow uint16 into a date somewhere in 2189."""
    with pytest.raises(ValueError, match="DAY_EPOCH"):
        _pack({"day": np.array([-1], "int64")}, {"day": DAY})


def test_a_count_past_int32_is_refused():
    with pytest.raises(OverflowError, match="does not fit int32"):
        _pack({"legion_count": np.array([2**31], "int64")}, {"legion_count": COUNT})


def test_the_check_covers_every_integer_column_not_a_chosen_few():
    """`area_id` is a uint16 carrying a country id, and nothing upstream promises 65,535.

    Which columns "can" overflow is a judgement that goes stale the moment a field is
    widened somewhere else, and the failure it lets through is silent.
    """
    with pytest.raises(OverflowError, match="area_id"):
        _pack({"area_id": np.array([70_000], "int64")}, {"area_id": "uint16"})


def test_a_null_is_refused_rather_than_packed_as_a_zero():
    """DuckDB returns a masked array for any column that carried nulls.

    `np.asarray` drops the mask and keeps what was underneath it, so the null becomes
    a real value - country 0, or a zone holding nothing - and reads as ordinary data
    everywhere downstream.
    """
    column = np.ma.masked_array([5, 0], mask=[False, True], dtype="int64")
    with pytest.raises(ValueError, match="country_id carries 1 null"):
        _pack({"country_id": column}, {"country_id": "uint16"})


def test_an_unsorted_index_cannot_be_delta_encoded():
    """For an unsigned column the encoding doubles as an assertion that it is sorted."""
    with pytest.raises(ValueError, match="sorted ascending"):
        _pack({"idx": np.array([5, 1], "int64")}, {"idx": IDX}, frozenset({"idx"}))
