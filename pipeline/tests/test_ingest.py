"""Ring arithmetic and the dtype contract.

The pipeline's correctness checks mostly live in dbt, against real data, because that is
where the interesting failures are. These two are the exception: both decide what gets
written before dbt ever sees it, and neither is observable in a mart once it has gone
wrong - a skipped day and a silently widened column both look like ordinary data.
"""

from __future__ import annotations

from datetime import date

import polars as pl
import pytest

from znhstry import config
from znhstry.ingest import RingGapError, plan_slots
from znhstry.schema import CHANGELOG_DTYPES, conform


def _history(tmp_path, newest: str):
    """A one-row changelog partition whose newest event is `newest`."""
    part = tmp_path / "year=2026"
    part.mkdir(parents=True)
    pl.DataFrame(
        {"ZoneId": [1], "LastUpdateDateUtc": [newest]},
    ).with_columns(pl.col("LastUpdateDateUtc").str.to_datetime("%Y-%m-%d %H:%M:%S")).write_parquet(
        part / "events.parquet"
    )
    return tmp_path


def test_one_slot_on_an_ordinary_night(tmp_path):
    # Slot 06 was the last read, so its tail is the first seconds of the 7th and the
    # 7th itself is still a sliver. The 7th has closed, so it is the slot to read.
    source = _history(tmp_path, "2026-08-07 00:01:21")
    assert plan_slots(date(2026, 8, 8), source) == [7]


def test_a_sliver_is_not_a_finished_day(tmp_path):
    """The bug this rule exists for.

    Having events *dated* the 7th does not mean the 7th was read - a slot spans
    midnight, so that is what reading slot 06 leaves behind. Comparing dates the
    obvious way would call the 7th done and skip it forever.
    """
    source = _history(tmp_path, "2026-08-07 00:01:21")
    assert plan_slots(date(2026, 8, 8), source) != []


def test_reading_a_slot_proves_the_day_is_done(tmp_path):
    # Events dated the 8th can only have come from slot 07, so the 7th is complete.
    source = _history(tmp_path, "2026-08-08 00:00:12")
    assert plan_slots(date(2026, 8, 8), source) == []


def test_a_missed_run_widens_the_window(tmp_path):
    source = _history(tmp_path, "2026-08-03 00:01:00")
    assert plan_slots(date(2026, 8, 8), source) == [3, 4, 5, 6, 7]


def test_slots_are_days_of_the_month_across_a_boundary(tmp_path):
    # Nothing since 30 July; 1 August has closed. Slots are day-of-month, so this
    # wraps to the end of the ring rather than counting forward.
    source = _history(tmp_path, "2026-07-30 00:01:00")
    assert plan_slots(date(2026, 8, 2), source) == [30, 31, 1]


def test_a_gap_wider_than_the_ring_refuses_to_run(tmp_path):
    """The slot holding that day has been overwritten with a newer month.

    Fetching it would append the wrong month's events and report success, which is
    strictly worse than stopping.
    """
    source = _history(tmp_path, "2026-06-01 00:01:00")
    with pytest.raises(RingGapError, match="ring only holds"):
        plan_slots(date(2026, 8, 8), source)


def test_exactly_the_ring_is_still_allowed(tmp_path):
    source = _history(tmp_path, "2026-07-08 00:01:00")
    assert len(plan_slots(date(2026, 8, 8), source)) == config.RING_SLOTS


def test_no_history_is_not_treated_as_an_empty_gap(tmp_path):
    with pytest.raises(RingGapError, match="no history"):
        plan_slots(date(2026, 8, 8), tmp_path)


def test_conform_casts_to_the_contract():
    df = pl.DataFrame(
        {
            "ZoneId": [1],
            "LastUpdateDateUtc": [None],
            "DateCapturedUtc": [None],
            "ZoneControlState": [2],
            "LegionCount": [1],
            "SwarmCount": [2],
            "FacelessCount": [3],
            "Extra": ["ignored"],
        },
        schema_overrides={"ZoneId": pl.Int64, "ZoneControlState": pl.Int64},
    ).with_columns(
        pl.col("LastUpdateDateUtc").cast(pl.Datetime("us")),
        pl.col("DateCapturedUtc").cast(pl.Datetime("us")),
    )

    out = conform(df, CHANGELOG_DTYPES)

    assert out.columns == list(CHANGELOG_DTYPES)
    assert out.schema == pl.Schema(CHANGELOG_DTYPES)


def test_conform_refuses_to_invent_a_missing_column():
    """Two paths write this Parquet and DuckDB reads them through one glob.

    Filling a missing column with nulls would push the failure downstream into
    whichever mart read it next, long after the evidence was gone.
    """
    with pytest.raises(ValueError, match="missing"):
        conform(pl.DataFrame({"ZoneId": [1]}), CHANGELOG_DTYPES)
