"""Two ways a published Parquet table can be wrong with nothing on disk to say so.

A HUGEINT column - any sum of BIGINT in DuckDB - goes into Parquet as DOUBLE, so a
consumer reads bot counts as floats. And a sort key that is not unique gives a file whose
byte order depends on the planner, so the nightly re-sends it every night and the ETag skip
never fires. Both files parse, both hold plausible values.

The third is the published dictionary: a manifest that lost its dbt descriptions still
parses and still renders, as a console listing twenty tables with nothing said about any
of them.
"""

from __future__ import annotations

import json

import duckdb
import pytest

from znhstry import config
from znhstry.marts import Table, read_dbt_docs, write_table


def test_hugeint_lands_as_bigint(tmp_path):
    con = duckdb.connect()
    con.execute("create table t as select 1 as k, cast(2 as hugeint) as total")

    entry = write_table(con, Table("t", ("k",)), tmp_path, {})

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
        write_table(con, Table("t", ("k",)), tmp_path, {})
    assert not (tmp_path / "t.parquet").exists()


def test_descriptions_ride_along_to_the_manifest(tmp_path):
    con = duckdb.connect()
    con.execute("create table t as select 1 as k, 2 as bots")
    docs = {"t": {"description": "One row per thing.", "columns": {"bots": "Bots present."}}}

    entry = write_table(con, Table("t", ("k",)), tmp_path, docs)

    assert entry["description"] == "One row per thing."
    # Only the documented column carries the key -- an empty string would render as a
    # documented column with nothing in it.
    assert entry["columns"] == [
        {"name": "k", "type": "INTEGER"},
        {"name": "bots", "type": "INTEGER", "description": "Bots present."},
    ]


def test_a_missing_dbt_manifest_is_loud(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DBT_MANIFEST", tmp_path / "manifest.json")

    with pytest.raises(FileNotFoundError, match="dbt build"):
        read_dbt_docs()


def test_only_models_and_only_non_empty_descriptions(tmp_path, monkeypatch):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "nodes": {
                    "model.p.kept": {
                        "resource_type": "model",
                        "name": "kept",
                        "description": "  Grain: one row per thing.  ",
                        "columns": {
                            "a": {"description": " Documented. "},
                            "b": {"description": "   "},
                        },
                    },
                    "test.p.dropped": {
                        "resource_type": "test",
                        "name": "dropped",
                        "description": "Not a table anyone can query.",
                    },
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "DBT_MANIFEST", manifest)

    docs = read_dbt_docs()

    assert set(docs) == {"kept"}
    assert docs["kept"]["description"] == "Grain: one row per thing."
    assert docs["kept"]["columns"] == {"a": "Documented."}

