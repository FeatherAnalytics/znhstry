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
    """`players` is a uint16, `report` a uint32, `day` a uint16 from DAY_EPOCH."""
    max_players, min_day, max_day, min_report, max_report = con.execute(f"""
        select max(b.total_active_players), min({DAY}), max({DAY}),
               min(b.battle_report_number), max(b.battle_report_number)
        from fct_zone_battles b join scope s on s.zone_id = b.zone_id
        where b.battle_date >= date '{config.RECORD_START}'
    """).fetchone()

    assert 0 <= max_players < 2**16
    # A day before the epoch would underflow into a plausible-looking date.
    assert min_day >= 0
    assert max_day < 2**16
    # Report numbers only ever climb, so this is the column that will reach its
    # ceiling first. ~131k today against 4.29 billion, but the check is free and
    # a silent wrap would send readers to somebody else's battle.
    assert min_report >= 0
    assert max_report < 2**32


def test_faction_launches_fit_their_column(con) -> None:
    """The three faction splits share `launches`' int32, and are never negative."""
    row = con.execute(f"""
        select max(greatest(b.legion_total_launches,
                            b.swarm_total_launches,
                            b.faceless_total_launches)),
               min(least(b.legion_total_launches,
                         b.swarm_total_launches,
                         b.faceless_total_launches))
        from fct_zone_battles b join scope s on s.zone_id = b.zone_id
        where b.battle_date >= date '{config.RECORD_START}'
    """).fetchone()
    assert row[1] >= 0
    assert row[0] < 2**31


def test_the_faction_split_shortfall_stays_inside_2019(con) -> None:
    """The three faction launch columns do not sum to `total_launches` everywhere.

    861 reports disagree across the whole source and every one falls between
    2019-07-01 and 2019-09-11, always with the total higher. The faction *player*
    columns fail on the same rows, so it is the whole per-faction block arriving
    partial - collection rather than play, documented rather than repaired. See
    `stg_battlestats` for the explanations that were measured and ruled out.

    This asserts the *containment*, not the count. If a shortfall ever appears
    outside that window, a faction-share chart elsewhere in the record has
    silently started reading an incomplete denominator.
    """
    outside = con.execute(f"""
        select count(*)
        from fct_zone_battles b join scope s on s.zone_id = b.zone_id
        where b.battle_date >= date '{config.RECORD_START}'
          and b.total_launches <> b.legion_total_launches
                                + b.swarm_total_launches
                                + b.faceless_total_launches
          and b.battle_date not between date '2019-07-01' and date '2019-09-11'
    """).fetchone()[0]
    assert outside == 0
