"""Publish the marts as Parquet, for anything that reads the warehouse from outside the map.

The export under `dist/data` is the map's own format: packed bytes, delta-encoded, sliced
the way the viewer fetches. Nothing else can read it without the decoder. This is the
other shape - one zstd Parquet file per table under `dist/marts/`, uploaded to the bucket
under `marts/`, so `read_parquet('https://.../marts/fct_zone_events.parquet')` works from
any DuckDB with nothing installed and no key.

Every file is written from a query that sorts on a key which is unique for that table.
Uniqueness is what makes the order total, and a total order is what makes the file
deterministic: an unchanged warehouse yields identical bytes, so the upload's ETag skip
holds and a quiet night sends nothing. A sort that leaves ties would re-send hundreds of
megabytes every night for no change, silently. `_assert_total_order` refuses to write one.

The sort key is also the pruning key. Parquet keeps min/max per row group, and a reader
filtering on the leading column skips every group whose range does not cover the value -
over HTTP that is range requests never made. `fct_zone_events` leads with `country_id`
because "one country's history" is the query everything downstream starts from.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

import duckdb

from . import config

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Table:
    name: str
    # Unique for the table, so the order is total. Leading column is the pruning column.
    sort: tuple[str, ...]


TABLES = (
    # `(zone_id, observed_at)` is unique across the stream, so `zone_id` closes the key.
    Table("fct_zone_events", ("country_id", "observed_at", "zone_id")),
    # Leads with country so a country filter prunes both sides of the join to events.
    Table("dim_zone", ("country_id", "zone_id")),
    Table("fct_country_daily", ("country_id", "activity_date")),
    Table("fct_global_daily", ("activity_date",)),
    Table("fct_zone_battles", ("battle_date", "battle_report_number")),
    # Every battle report, tournament ones included. `fct_zone_battles` drops those
    # because it has nowhere to draw them; anything counting reports needs this.
    Table("stg_battlestats", ("battle_date", "battle_report_number")),
    Table("stg_atlantis_leaderboard", ("observed_at", "faction", "player_name")),
    Table("stg_atlantis_zones", ("observed_at", "zone")),
    Table("stg_atlantis_zone_months", ("tournament_month", "zone")),
    Table("stg_atlantis_tournaments", ("tournament_month",)),
)

# Rows per row group. ~100 groups over the 9.9M-row event table: small enough that a
# country filter reads a few of them, large enough that the footer stays a few KB.
ROW_GROUP_SIZE = 100_000

MANIFEST = "_meta.json"


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _select_list(con: duckdb.DuckDBPyConnection, table: str) -> str:
    """Every column by name, with HUGEINT narrowed to BIGINT.

    Sums of BIGINT come out of DuckDB as HUGEINT, and Parquet has no int128: DuckDB
    writes the column as DOUBLE, so a consumer gets floats for bot counts. The largest
    value in the record is nine digits; BIGINT holds nineteen.
    """
    parts = []
    for name, dtype, *_ in con.execute(f"describe {_quote(table)}").fetchall():
        if dtype == "HUGEINT":
            parts.append(f"cast({_quote(name)} as bigint) as {_quote(name)}")
        else:
            parts.append(_quote(name))
    return ", ".join(parts)


def _assert_total_order(con: duckdb.DuckDBPyConnection, table: Table) -> None:
    key = ", ".join(_quote(c) for c in table.sort)
    (dupes,) = con.execute(
        f"select count(*) from (select 1 from {_quote(table.name)} group by {key} "
        f"having count(*) > 1)"
    ).fetchone()
    if dupes:
        raise ValueError(
            f"{table.name}: sort key ({', '.join(table.sort)}) is not unique - "
            f"{dupes:,} duplicate groups. The file would not be deterministic."
        )


def write_table(con: duckdb.DuckDBPyConnection, table: Table, out: Path) -> dict:
    """Write one table as zstd Parquet and return its manifest entry."""
    _assert_total_order(con, table)
    path = out / f"{table.name}.parquet"
    tmp = path.with_name(path.name + ".tmp")
    # Explicit, not DuckDB's default: `fct_zone_events.country_id` is null for a zone
    # missing from `dim_zone`, and a null that sorted wherever the planner put it would
    # move between runs. `group by` in the uniqueness check treats nulls as one value,
    # so the two agree.
    key = ", ".join(f"{_quote(c)} nulls last" for c in table.sort)
    target = str(tmp).replace("'", "''")
    con.execute(
        f"copy (select {_select_list(con, table.name)} from {_quote(table.name)} "
        f"order by {key}) to '{target}' "
        f"(format parquet, compression zstd, row_group_size {ROW_GROUP_SIZE})"
    )
    tmp.replace(path)

    # Types read back from the file, not from the warehouse, so the manifest describes
    # what a consumer will see - BIGINT where HUGEINT was narrowed.
    source = str(path).replace("'", "''")
    columns = [
        {"name": name, "type": dtype}
        for name, dtype, *_ in con.execute(
            f"describe select * from read_parquet('{source}')"
        ).fetchall()
    ]
    (rows,) = con.execute(f"select count(*) from read_parquet('{source}')").fetchone()
    return {
        "path": path.name,
        "rows": rows,
        "bytes": path.stat().st_size,
        "sort": list(table.sort),
        "columns": columns,
    }


def export_marts(out: Path | None = None) -> None:
    out = out or config.MARTS_OUT
    out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(config.DUCKDB_PATH), read_only=True)
    try:
        names = {t.name for t in TABLES}
        # A table dropped from TABLES must not linger: the upload sends the directory.
        for stale in out.iterdir():
            if stale.suffix == ".tmp" or (stale.suffix == ".parquet" and stale.stem not in names):
                stale.unlink()

        tables = {}
        for table in TABLES:
            entry = write_table(con, table, out)
            tables[table.name] = entry
            log.info(
                "%-26s %s rows  %s MB",
                table.name,
                f"{entry['rows']:,}",
                f"{entry['bytes'] / 1e6:.1f}",
            )

        (newest,) = con.execute("select max(activity_date) from fct_zone_events").fetchone()
    finally:
        con.close()

    # Last, so a reader that finds the manifest finds every file it names. No timestamp:
    # an unchanged warehouse must yield an identical manifest.
    manifest = {"newest_event_date": newest.isoformat(), "tables": tables}
    tmp = out / (MANIFEST + ".tmp")
    tmp.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    tmp.replace(out / MANIFEST)
    log.info("marts complete: %s tables under %s", len(tables), out)
