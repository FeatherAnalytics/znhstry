"""Two ways a published Parquet table can be wrong with nothing on disk to say so.

A HUGEINT column - any sum of BIGINT in DuckDB - goes into Parquet as DOUBLE, so a
consumer reads bot counts as floats. And a sort key that is not unique gives a file whose
byte order depends on the planner, so the nightly re-sends it every night and the ETag skip
never fires. Both files parse, both hold plausible values.
"""

from __future__ import annotations

import duckdb
import pytest

from znhstry.marts import Table, write_table


def test_hugeint_lands_as_bigint(tmp_path):
    con = duckdb.connect()
    con.execute("create table t as select 1 as k, cast(2 as hugeint) as total")

    entry = write_table(con, Table("t", ("k",)), tmp_path)

    described = con.execute(
        f"describe select * from read_parquet('{tmp_path}/t.parquet')"
    ).fetchall()
    assert [(n, t) for n, t, *_ in described] == [("k", "INTEGER"), ("total", "BIGINT")]
    assert entry["columns"] == [
        {"name": "k", "type": "INTEGER"},
        {"name": "total", "type": "BIGINT"},
    ]


def test_a_sort_key_with_ties_is_refused(tmp_path):
    con = duckdb.connect()
    con.execute("create table t as select * from (values (1, 'a'), (1, 'b')) v(k, name)")

    with pytest.raises(ValueError, match="not unique"):
        write_table(con, Table("t", ("k",)), tmp_path)
    assert not (tmp_path / "t.parquet").exists()
