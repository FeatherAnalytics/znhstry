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

import gzip
import json
import logging
import math
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import polars as pl

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


def _create_scope(con: duckdb.DuckDBPyConnection, scope: config.Scope, out: Path) -> int:
    """Materialise the zones in scope with a dense index.

    Haversine rather than the spatial extension: four lines of SQL against a
    bbox prefilter is faster to run and one less dependency to install. A scope
    with no radius covers the whole map.
    """
    filters = ["latitude is not null"]

    if scope.radius_km is not None:
        lat_min, lat_max, lon_min, lon_max = _bbox(scope.lat, scope.lon, scope.radius_km)
        filters.append(f"latitude between {lat_min} and {lat_max}")
        filters.append(f"longitude between {lon_min} and {lon_max}")
        filters.append(f"""
            {config.EARTH_RADIUS_KM} * 2 * asin(sqrt(
                pow(sin(radians(latitude - {scope.lat}) / 2), 2)
                + cos(radians({scope.lat})) * cos(radians(latitude))
                  * pow(sin(radians(longitude - {scope.lon}) / 2), 2)
            )) <= {scope.radius_km}
        """)

    if scope.active_only:
        filters.append("zone_id in (select zone_id from fct_zone_events)")

    con.execute(f"""
        create or replace temp view scope_members as
        select zone_id from dim_zone where {" and ".join(filters)}
    """)

    previous = _previous_index(out)
    if previous is None:
        con.execute("""
            create or replace temp table scope as
            select
                cast(row_number() over (order by z.zone_id) - 1 as integer) as idx,
                z.zone_id, z.zone_name, z.latitude, z.longitude, z.region_id, z.country_id
            from dim_zone z join scope_members m on m.zone_id = z.zone_id
        """)
    else:
        # idx is a permanent handle, not a row number. A dormant zone waking up
        # would otherwise be inserted mid-sequence and renumber everything after
        # it, invalidating every checkpoint and event shard already committed --
        # 97MB rewritten over one new zone. Existing zones keep their index
        # forever, new ones are appended, and zones that leave the scope stay as
        # tombstones so nothing behind them moves.
        con.register("previous_index", previous)
        con.execute("""
            create or replace temp table scope as
            with assigned as (
                select zone_id, idx from previous_index
                union all
                select m.zone_id,
                       (select max(idx) from previous_index)
                           + cast(row_number() over (order by m.zone_id) as integer)
                from scope_members m
                where m.zone_id not in (select zone_id from previous_index)
            )
            select cast(a.idx as integer) as idx,
                   z.zone_id, z.zone_name, z.latitude, z.longitude, z.region_id, z.country_id
            from assigned a join dim_zone z on z.zone_id = a.zone_id
        """)
        added = con.execute("select count(*) from scope").fetchone()[0] - previous.height
        if added:
            log.info("  %s zones appended to the stable index", f"{added:,}")

    return con.execute("select count(*) from scope").fetchone()[0]


def _previous_index(out: Path) -> pl.DataFrame | None:
    """Recover the zone_id -> idx assignment from a prior export.

    zones.bin.gz already stores zone_id at each index, so it is its own index
    manifest and there is no second file to keep in sync.
    """
    meta_path, zones_path = out / "meta.json", out / "zones.bin.gz"
    if not (meta_path.exists() and zones_path.exists()):
        return None

    entry = json.loads(meta_path.read_text())["zones"]
    rows = entry["rows"]
    offset = 0
    for name, dtype, _ in entry["columns"]:
        if name == "zone_id":
            break
        offset += rows * np.dtype(dtype).itemsize
    else:
        raise ValueError(f"{zones_path} has no zone_id column to recover the index from")
    buf = gzip.decompress(zones_path.read_bytes())
    zone_ids = np.frombuffer(buf, dtype="int32", count=rows, offset=offset)
    return pl.DataFrame({"zone_id": zone_ids, "idx": np.arange(rows, dtype="int32")})


def _write_columnar(
    path: Path,
    sql: str,
    columns: dict[str, str],
    con: duckdb.DuckDBPyConnection,
    delta: frozenset[str] = frozenset(),
) -> dict[str, Any]:
    """Run `sql`, dump the named columns back to back, gzip, return a manifest entry.

    Columns named in `delta` are stored as successive differences. Sorted index
    columns become long runs of small numbers, which gzip squeezes hard: 5.7x
    on a checkpoint versus 3.2x for gzip alone, and losslessly - better than
    quantising the counts, which costs precision for less.

    Output is gzip because browsers decompress it natively through
    DecompressionStream, so the client needs no library.
    """
    data = con.execute(sql).fetchnumpy()
    rows = len(next(iter(data.values()))) if data else 0

    payload = bytearray()
    spec: list[list[Any]] = []
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

        encoding = None
        if name in delta and rows:
            column = np.diff(column.astype("int64"), prepend=np.int64(0))
            if column.min() < 0:
                raise ValueError(f"{name} must be sorted ascending to delta-encode")
            encoding = "delta"

        payload += np.ascontiguousarray(column, dtype=dtype).tobytes()
        spec.append([name, dtype, encoding])

    path.parent.mkdir(parents=True, exist_ok=True)
    raw_bytes = len(payload)
    path.write_bytes(gzip.compress(bytes(payload), 6))

    return {
        "path": path.name,
        "rows": int(rows),
        "columns": spec,
        "bytes": path.stat().st_size,
        "raw_bytes": raw_bytes,
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
        out / "zones.bin.gz",
        "select idx, zone_id, latitude, longitude from scope order by idx",
        {"latitude": "float32", "longitude": "float32", "zone_id": "int32"},
        con,
    )
    # Names are only needed on hover, so they load lazily and stay out of the
    # binary. Index-aligned array, not a map, to keep it compact.
    names = [row[0] for row in con.execute("select zone_name from scope order by idx").fetchall()]
    names_path = out / "zone_names.json.gz"
    names_path.write_bytes(
        gzip.compress(json.dumps(names, ensure_ascii=False).encode("utf-8"), 6)
    )
    entry["names"] = {"path": names_path.name, "bytes": names_path.stat().st_size}
    return entry


def _export_checkpoints(con: duckdb.DuckDBPyConnection, out: Path) -> list[dict[str, Any]]:
    """Dense year-boundary snapshots, one file per boundary."""
    # Past boundaries only. A boundary in the future is really "state as of
    # now", so it would be rewritten every night -- and because gzip output
    # changes wholesale with its input, git cannot delta it and would store the
    # full file again each time. Every shard here is immutable once written;
    # the client derives current state from the last checkpoint plus the event
    # shards after it, which is the design intent anyway.
    years = [
        int(row[0])
        for row in con.execute(
            "select distinct year(checkpoint_date) from fct_zone_checkpoints "
            "where checkpoint_date <= current_date order by 1"
        ).fetchall()
    ]
    entries = []
    for year in years:
        entry = _write_columnar(
            out / "checkpoints" / f"{year}.bin.gz",
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
            delta=frozenset({"idx"}),
        )
        entry["year"] = year
        entries.append(entry)
        log.info("  checkpoint %d: %s zones, %s KB", year, f"{entry['rows']:,}", entry["bytes"] // 1024)
    return entries


def _export_events(con: duckdb.DuckDBPyConnection, out: Path) -> list[dict[str, Any]]:
    """Event streams, sharded by month.

    Monthly rather than yearly so nightly updates stay cheap to commit: only
    the current month's shard is rewritten and every earlier one is immutable,
    so git stores each month once instead of once per night.

    Rows are ordered by (zone, day) rather than by timestamp. Grouping a zone's
    trajectory together is what makes the stream compress - 4x versus 3.1x for
    timestamp order - and the client rebuilds a day index on load in
    milliseconds.
    """
    months = con.execute("""
        select distinct year(e.activity_date) as y, month(e.activity_date) as m
        from fct_zone_events e join scope s on s.zone_id = e.zone_id
        order by 1, 2
    """).fetchall()

    entries = []
    for year, month in months:
        entry = _write_columnar(
            out / "events" / f"{year:04d}-{month:02d}.bin.gz",
            f"""
            select
                s.idx,
                cast(date_diff('day', date '{config.DAY_EPOCH}', e.activity_date) as integer) as day,
                e.control_state, e.legion_count, e.swarm_count, e.faceless_count
            from fct_zone_events e
            join scope s on s.zone_id = e.zone_id
            where year(e.activity_date) = {year} and month(e.activity_date) = {month}
            order by s.idx, e.activity_date
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
            delta=frozenset({"idx"}),
        )
        entry["year"], entry["month"] = int(year), int(month)
        entries.append(entry)
    total = sum(e["rows"] for e in entries)
    log.info("  events: %s rows across %d monthly shards", f"{total:,}", len(entries))
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
        path = out / "series" / f"{name}.json.gz"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(
            gzip.compress(json.dumps(payload, separators=(",", ":")).encode("utf-8"), 6)
        )
        written[name] = {"path": f"series/{name}.json.gz", "bytes": path.stat().st_size}
        log.info("  series %s: %s KB", name, path.stat().st_size // 1024)
    return written


def export_all(scope_name: str | None = None, out: Path | None = None) -> None:
    scope = config.SCOPES[scope_name or config.DEFAULT_SCOPE]
    out = out or (config.WEB_DATA / scope.name)
    out.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect(str(config.DUCKDB_PATH), read_only=True)
    try:
        zone_count = _create_scope(con, scope, out)
        log.info("scope %s: %s zones", scope.name, f"{zone_count:,}")

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
                "name": scope.name,
                "label": scope.label,
                "center": [scope.lat, scope.lon] if scope.radius_km else None,
                "radius_km": scope.radius_km,
                "active_only": scope.active_only,
                "zone_count": zone_count,
            },
            "day_epoch": config.DAY_EPOCH.isoformat(),
            "date_range": [span[0].isoformat(), span[1].isoformat()],
            "factions": {"0": "uncaptured", "1": "legion", "2": "swarm", "3": "faceless"},
            "zones": zones,
            "checkpoints": checkpoints,
            "events": events,
            "series": series,
            "encoding": {
                "container": "gzip",
                "note": (
                    "Every .gz is a gzip stream over a columnar dump: each column is a "
                    "contiguous run of one fixed-width dtype, concatenated in the order "
                    "listed. Decompress with DecompressionStream('gzip'), then take "
                    "typed-array views at the running offsets. A column marked 'delta' "
                    "holds successive differences; prefix-sum it to recover values."
                ),
                "event_order": "(zone idx, day) - build a day index on load, not file order",
            },
            "notes": [
                "Series are sparse: carry the previous value forward across gaps.",
                "2019 has an upstream collection gap and is not a real lull.",
                "Bot counts before 2012-05 are the backfill baseline, not observations.",
            ],
        }
        (out / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

        groups = (checkpoints, events)
        total = (
            sum(entry["bytes"] for group in groups for entry in group)
            + zones["bytes"]
            + zones["names"]["bytes"]
            + sum(s["bytes"] for s in series.values())
        )
        raw = sum(entry["raw_bytes"] for group in groups for entry in group) + zones["raw_bytes"]
        log.info(
            "export complete: %s MB across %s files (%.1fx smaller than raw)",
            f"{total / 1e6:.1f}",
            len(checkpoints) + len(events) + 5,
            raw / total if total else 0,
        )
    finally:
        con.close()
