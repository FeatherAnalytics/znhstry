"""Slice the DuckDB marts into static files the browser can load directly.

Binary payloads are plain columnar dumps: every column is a contiguous run of
one fixed-width dtype, concatenated in the order the manifest lists them. The
client reads them as typed-array views over a single ArrayBuffer, so there is
no parsing step and no decoding library.

Series are JSON and deliberately **sparse** - only days a value actually
changed. The client carries the last value forward, the same trick the dbt
layer uses to make dormant zones free.
"""

from __future__ import annotations

import json
import logging
import math
from pathlib import Path
from typing import Any

import duckdb
import numpy as np

from . import config

log = logging.getLogger(__name__)

# Column dtypes, chosen to be the narrowest that cannot overflow.
#   idx     - dense 0..N-1 index into zones.bin, not the sparse upstream ZoneId
#   day     - days since config.DAY_EPOCH
#   faction - 0 uncaptured, 1 legion, 2 swarm, 3 faceless
IDX = "uint32"
DAY = "uint16"
FACTION = "uint8"
COUNT = "int32"

_ITEMSIZE = {"uint8": 1, "uint16": 2, "uint32": 4, "int32": 4, "float32": 4}


# The bbox is only a prefilter - haversine decides membership - so it must
# never be tighter than the true circle. 111.32 km/degree is a mid-latitude
# average, and a degree is shorter than that near the equator, which made the
# box narrower than 1000 miles and clipped 11 edge zones before haversine saw
# them. The margin makes the prefilter unambiguously generous.
_BBOX_MARGIN = 1.05


def _bbox(lat: float, lon: float, radius_km: float) -> tuple[float, float, float, float]:
    """Indexable prefilter around the scope circle. Deliberately over-wide."""
    lat_delta = _BBOX_MARGIN * radius_km / 111.32
    lon_delta = _BBOX_MARGIN * radius_km / (111.32 * math.cos(math.radians(lat)))
    return (
        max(lat - lat_delta, -90.0),
        min(lat + lat_delta, 90.0),
        lon - lon_delta,
        lon + lon_delta,
    )


def _create_scope(con: duckdb.DuckDBPyConnection) -> int:
    """Materialise the zones in scope with a dense index.

    Haversine rather than the spatial extension: four lines of SQL against a
    bbox prefilter is faster to run and one less dependency to install.
    """
    lat_min, lat_max, lon_min, lon_max = _bbox(
        config.SCOPE_LAT, config.SCOPE_LON, config.SCOPE_RADIUS_KM
    )
    con.execute(f"""
        create or replace temp table scope as
        select
            cast(row_number() over (order by zone_id) - 1 as integer) as idx,
            zone_id, zone_name, latitude, longitude, region_id, country_id
        from dim_zone
        where latitude between {lat_min} and {lat_max}
          and longitude between {lon_min} and {lon_max}
          and {config.EARTH_RADIUS_KM} * 2 * asin(sqrt(
                pow(sin(radians(latitude - {config.SCOPE_LAT}) / 2), 2)
                + cos(radians({config.SCOPE_LAT})) * cos(radians(latitude))
                  * pow(sin(radians(longitude - {config.SCOPE_LON}) / 2), 2)
              )) <= {config.SCOPE_RADIUS_KM}
    """)
    return con.execute("select count(*) from scope").fetchone()[0]


def _write_columnar(
    path: Path, sql: str, columns: dict[str, str], con: duckdb.DuckDBPyConnection
) -> dict[str, Any]:
    """Run `sql`, dump the named columns back to back, return a manifest entry."""
    data = con.execute(sql).fetchnumpy()
    rows = len(next(iter(data.values()))) if data else 0

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        for name, dtype in columns.items():
            column = np.asarray(data[name])
            if rows and dtype in (COUNT, DAY):
                # Silent wraparound is the failure mode these dumps are most
                # exposed to. A negative day would come from an event before
                # DAY_EPOCH - the 2010 backfill rows - and underflow uint16
                # into a plausible-looking date rather than an error.
                low, high = int(column.min()), int(np.abs(column).max())
                limit = np.iinfo(np.uint16 if dtype == DAY else np.int32).max
                if high > limit:
                    raise OverflowError(f"{name} max {high:,} does not fit {dtype}")
                if dtype == DAY and low < 0:
                    raise ValueError(f"{name} has values before DAY_EPOCH (min {low})")
            handle.write(np.ascontiguousarray(column, dtype=dtype).tobytes())

    return {
        "path": path.name,
        "rows": int(rows),
        "columns": [[name, dtype] for name, dtype in columns.items()],
        "bytes": path.stat().st_size,
    }


def _years(con: duckdb.DuckDBPyConnection, table: str, column: str) -> list[int]:
    return [
        int(row[0])
        for row in con.execute(f"""
            select distinct year({column}) from {table} t
            join scope s on s.zone_id = t.zone_id order by 1
        """).fetchall()
    ]


def _export_zones(con: duckdb.DuckDBPyConnection, out: Path) -> dict[str, Any]:
    """Static geometry, index-aligned. Positions never change."""
    entry = _write_columnar(
        out / "zones.bin",
        "select idx, zone_id, latitude, longitude from scope order by idx",
        {"latitude": "float32", "longitude": "float32", "zone_id": "int32"},
        con,
    )
    # Names are only needed on hover, so they load lazily and stay out of the
    # binary. Index-aligned array, not a map, to keep it compact.
    names = [row[0] for row in con.execute("select zone_name from scope order by idx").fetchall()]
    names_path = out / "zone_names.json"
    names_path.write_text(json.dumps(names, ensure_ascii=False), encoding="utf-8")
    entry["names"] = {"path": names_path.name, "bytes": names_path.stat().st_size}
    return entry


def _export_checkpoints(con: duckdb.DuckDBPyConnection, out: Path) -> list[dict[str, Any]]:
    """Dense year-boundary snapshots, one file per boundary."""
    years = [
        int(row[0])
        for row in con.execute(
            "select distinct year(checkpoint_date) from fct_zone_checkpoints order by 1"
        ).fetchall()
    ]
    entries = []
    for year in years:
        entry = _write_columnar(
            out / "checkpoints" / f"{year}.bin",
            f"""
            select s.idx, c.control_state, c.legion_count, c.swarm_count, c.faceless_count
            from fct_zone_checkpoints c
            join scope s on s.zone_id = c.zone_id
            where c.checkpoint_date = date '{year}-01-01'
            order by s.idx
            """,
            {
                "idx": IDX,
                "control_state": FACTION,
                "legion_count": COUNT,
                "swarm_count": COUNT,
                "faceless_count": COUNT,
            },
            con,
        )
        entry["year"] = year
        entries.append(entry)
        log.info("  checkpoint %d: %s zones, %s KB", year, f"{entry['rows']:,}", entry["bytes"] // 1024)
    return entries


def _export_events(con: duckdb.DuckDBPyConnection, out: Path) -> list[dict[str, Any]]:
    """Intra-year event streams, ordered so the client can replay them."""
    entries = []
    for year in _years(con, "fct_zone_events", "t.activity_date"):
        entry = _write_columnar(
            out / "events" / f"{year}.bin",
            f"""
            select
                s.idx,
                cast(date_diff('day', date '{config.DAY_EPOCH}', e.activity_date) as integer) as day,
                e.control_state, e.legion_count, e.swarm_count, e.faceless_count
            from fct_zone_events e
            join scope s on s.zone_id = e.zone_id
            where year(e.activity_date) = {year}
            order by e.observed_at
            """,
            {
                "idx": IDX,
                "day": DAY,
                "control_state": FACTION,
                "legion_count": COUNT,
                "swarm_count": COUNT,
                "faceless_count": COUNT,
            },
            con,
        )
        entry["year"] = year
        entries.append(entry)
        log.info("  events %d: %s rows, %s KB", year, f"{entry['rows']:,}", entry["bytes"] // 1024)
    return entries


def _sparse_series(con: duckdb.DuckDBPyConnection, sql: str) -> dict[str, Any]:
    """Keep only rows where a faction total moved. The client steps forward."""
    rows = con.execute(sql).fetchall()
    return {
        "columns": ["day", "legion", "swarm", "faceless"],
        "rows": [[int(value) for value in row] for row in rows],
    }


def _export_series(con: duckdb.DuckDBPyConnection, out: Path) -> dict[str, Any]:
    changed = """
        where legion_delta != 0 or swarm_delta != 0 or faceless_delta != 0
    """
    day = f"cast(date_diff('day', date '{config.DAY_EPOCH}', activity_date) as integer)"

    global_series = _sparse_series(
        con,
        f"""
        select {day}, legion_bots, swarm_bots, faceless_bots
        from fct_global_daily {changed} order by activity_date
        """,
    )

    # Bots inside the scope only - the headline number for this viewer.
    scope_series = _sparse_series(
        con,
        f"""
        with daily as (
            select e.activity_date,
                   sum(e.legion_delta)   as legion_delta,
                   sum(e.swarm_delta)    as swarm_delta,
                   sum(e.faceless_delta) as faceless_delta
            from fct_zone_events e join scope s on s.zone_id = e.zone_id
            group by 1
        ),
        cumulative as (
            select activity_date,
                   sum(legion_delta)   over w as legion_bots,
                   sum(swarm_delta)    over w as swarm_bots,
                   sum(faceless_delta) over w as faceless_bots
            from daily
            window w as (order by activity_date rows between unbounded preceding and current row)
        )
        select {day}, legion_bots, swarm_bots, faceless_bots
        from cumulative order by activity_date
        """,
    )

    countries = con.execute(f"""
        select f.country_id, any_value(f.country_name) as country_name,
               list({day} order by f.activity_date)        as days,
               list(f.legion_bots order by f.activity_date)   as legion,
               list(f.swarm_bots order by f.activity_date)    as swarm,
               list(f.faceless_bots order by f.activity_date) as faceless
        from fct_country_daily f
        {changed}
        group by f.country_id order by f.country_id
    """).fetchall()

    country_series = {
        "columns": ["day", "legion", "swarm", "faceless"],
        "countries": [
            {
                "country_id": int(row[0]),
                "country_name": row[1],
                "rows": [
                    [int(d), int(le), int(sw), int(fa)]
                    for d, le, sw, fa in zip(row[2], row[3], row[4], row[5], strict=True)
                ],
            }
            for row in countries
        ],
    }

    written = {}
    for name, payload in (
        ("global_daily", global_series),
        ("scope_daily", scope_series),
        ("country_daily", country_series),
    ):
        path = out / "series" / f"{name}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        written[name] = {"path": f"series/{name}.json", "bytes": path.stat().st_size}
        log.info("  series %s: %s KB", name, path.stat().st_size // 1024)
    return written


def export_all(out: Path | None = None) -> None:
    out = out or config.WEB_DATA
    out.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect(str(config.DUCKDB_PATH), read_only=True)
    try:
        zone_count = _create_scope(con)
        log.info("scope %s: %s zones", config.SCOPE_NAME, f"{zone_count:,}")

        zones = _export_zones(con, out)
        log.info("zones: %s KB (+ %s KB names)", zones["bytes"] // 1024, zones["names"]["bytes"] // 1024)

        checkpoints = _export_checkpoints(con, out)
        events = _export_events(con, out)
        series = _export_series(con, out)

        span = con.execute(
            "select min(activity_date), max(activity_date) from fct_zone_events e "
            "join scope s on s.zone_id = e.zone_id"
        ).fetchone()

        meta = {
            "scope": {
                "name": config.SCOPE_NAME,
                "label": config.SCOPE_LABEL,
                "center": [config.SCOPE_LAT, config.SCOPE_LON],
                "radius_km": config.SCOPE_RADIUS_KM,
                "zone_count": zone_count,
            },
            "day_epoch": config.DAY_EPOCH.isoformat(),
            "date_range": [span[0].isoformat(), span[1].isoformat()],
            "factions": {"0": "uncaptured", "1": "legion", "2": "swarm", "3": "faceless"},
            "zones": zones,
            "checkpoints": checkpoints,
            "events": events,
            "series": series,
            "notes": [
                "Series are sparse: carry the previous value forward across gaps.",
                "2019 has an upstream collection gap and is not a real lull.",
                "Bot counts before 2012-05 are the backfill baseline, not observations.",
            ],
        }
        (out / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

        total = sum(
            entry["bytes"]
            for group in (checkpoints, events)
            for entry in group
        ) + zones["bytes"] + zones["names"]["bytes"] + sum(s["bytes"] for s in series.values())
        log.info("export complete: %s MB across %s files", f"{total / 1e6:.1f}", len(checkpoints) + len(events) + 5)
    finally:
        con.close()
