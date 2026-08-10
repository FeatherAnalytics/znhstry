"""The MAZ shards must stay row-aligned, and nothing else can tell you if they don't.

`maz.bin.br` carries `(idx, day)`; `maz_stats.bin.br` carries the metrics for the same
reports and **no key columns at all**, because the row number is the key. That is the
frugal shape - repeating the zone and the date would be two more columns saying what the
other file already says - and it is only safe while both queries group and order
identically.

A drift here is invisible in every direction. Both files still parse, both still have
plausible values, and the viewer never reads the stats, so nothing on screen changes. The
first symptom would be a dashboard attributing one zone's launches to another.

These run against the real warehouse when it is present and skip otherwise, because the
thing under test is the SQL agreeing with itself over real data rather than a fixture.
"""

from __future__ import annotations

import duckdb
import pytest

from znhstry import config

pytestmark = pytest.mark.skipif(
    not config.DUCKDB_PATH.exists(), reason="warehouse not built"
)


@pytest.fixture(scope="module")
def con():
    connection = duckdb.connect(str(config.DUCKDB_PATH), read_only=True)
    # A stand-in for the export's scope table. The real one preserves idx across
    # runs; for row alignment only the join and the ordering matter.
    connection.execute("""
        create or replace temp table scope as
        select cast(row_number() over (order by zone_id) - 1 as integer) as idx, zone_id
        from dim_zone where latitude is not null
    """)
    yield connection
    connection.close()


def _rows(con, select: str, group: str, order: str) -> list[tuple]:
    return con.execute(f"""
        select {select}
        from fct_zone_battles b join scope s on s.zone_id = b.zone_id
        where b.battle_date >= date '{config.RECORD_START}'
        group by {group} order by {order}
    """).fetchall()


DAY = f"cast(date_diff('day', date '{config.DAY_EPOCH}', b.battle_date) as integer)"


def test_maz_and_stats_have_the_same_rows_in_the_same_order(con) -> None:
    """Row `i` of the stats must describe row `i` of the reports."""
    reports = _rows(con, f"s.idx, {DAY} as day", f"s.idx, {DAY}", "day, s.idx")
    stats = _rows(
        con,
        f"s.idx, {DAY} as day, max(b.total_launches) as launches",
        "s.idx, b.battle_date",
        f"{DAY}, s.idx",
    )

    assert len(reports) == len(stats), "the two shards would be written different lengths"
    assert [(r[0], r[1]) for r in reports] == [(s[0], s[1]) for s in stats]


def test_report_grain_is_one_row_per_zone_day(con) -> None:
    """`_pack` writes what the query returns; a duplicate would double a zone's ring."""
    total, distinct = con.execute(f"""
        select count(*), count(distinct (s.idx, b.battle_date))
        from fct_zone_battles b join scope s on s.zone_id = b.zone_id
        where b.battle_date >= date '{config.RECORD_START}'
    """).fetchone()
    assert total == distinct


def test_packed_columns_cannot_overflow(con) -> None:
    """`players` is a uint16 and `day` a uint16 offset from DAY_EPOCH."""
    max_players, min_day, max_day = con.execute(f"""
        select max(b.total_active_players), min({DAY}), max({DAY})
        from fct_zone_battles b join scope s on s.zone_id = b.zone_id
        where b.battle_date >= date '{config.RECORD_START}'
    """).fetchone()

    assert 0 <= max_players < 2**16
    # A day before the epoch would underflow into a plausible-looking date.
    assert min_day >= 0
    assert max_day < 2**16
