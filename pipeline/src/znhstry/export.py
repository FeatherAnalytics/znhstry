"""Slice the DuckDB marts into static files the browser can load directly.

Binary payloads are plain columnar dumps: every column is a contiguous run of
one fixed-width dtype, concatenated in the order the manifest lists them. The
client reads them as typed-array views over a single ArrayBuffer, so there is
no parsing step and no decoding library.

Checkpoints and events shard by **web-mercator tile** as well as by time, so a
viewport downloads only the tiles it can see rather than the whole planet. The
chart never walks per-zone events across tiles -- it sums a pre-aggregated
series per tile instead. That is deliberate: a per-zone delta walk needs every
event a zone ever had, so a zone whose earlier history sat in an unloaded tile
would book its entire lifetime as a single day's change.

Series are JSON and deliberately **sparse** - only days a value actually
changed. The client carries the last value forward, the same trick the dbt
layer uses to make dormant zones free.
"""

from __future__ import annotations

import gzip
import json
import logging
import math
import shutil
from datetime import date
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

CHECKPOINT_COLUMNS = {
    "idx": IDX,
    "control_state": FACTION,
    "legion_count": COUNT,
    "swarm_count": COUNT,
    "faceless_count": COUNT,
}

EVENT_COLUMNS = {
    "idx": IDX,
    "day": DAY,
    "control_state": FACTION,
    "legion_count": COUNT,
    "swarm_count": COUNT,
    "faceless_count": COUNT,
}

SERIES_COLUMNS = ["day", "legion", "swarm", "faceless"]


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


# --- Tiling ---------------------------------------------------------------
#
# Tiles are packed into one integer, `tile_key = x * side + y`, purely so the
# grouping happens in SQL and numpy rather than on Python strings. The name on
# disk and in the manifest is "{x}-{y}".


def _tile_key_sql(lat: str, lon: str) -> str:
    """SQL for the packed tile key of a lat/lon pair, at config.TILE_ZOOM."""
    side = 2**config.TILE_ZOOM
    limit = config.MERCATOR_LAT_LIMIT
    clamped = f"least(greatest({lat}, -{limit}), {limit})"
    # least(..., side - 1) catches lon exactly 180 and lat at the clamp, either
    # of which lands one tile past the edge of the grid.
    x = f"least(cast(floor(({lon} + 180.0) / 360.0 * {side}) as integer), {side - 1})"
    y = (
        f"least(cast(floor((1 - ln(tan(radians({clamped}))"
        f" + 1 / cos(radians({clamped}))) / pi()) / 2 * {side}) as integer), {side - 1})"
    )
    return f"greatest({x}, 0) * {side} + greatest({y}, 0)"


def _tile_name(key: int) -> str:
    x, y = divmod(key, 2**config.TILE_ZOOM)
    return f"{x}-{y}"


def _tile_bbox(key: int) -> list[float]:
    """[west, south, east, north] for a tile, so the client need not project."""
    side = 2**config.TILE_ZOOM
    x, y = divmod(key, side)

    def lat_at(row: int) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * row / side))))

    return [
        x / side * 360.0 - 180.0,
        lat_at(y + 1),
        (x + 1) / side * 360.0 - 180.0,
        lat_at(y),
    ]


def _create_scope(con: duckdb.DuckDBPyConnection, scope: config.Scope, out: Path) -> int:
    """Materialise the zones in scope with a dense index and a tile assignment.

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

    tile_key = _tile_key_sql("z.latitude", "z.longitude")
    previous = _previous_index(out)
    if previous is None:
        con.execute(f"""
            create or replace temp table scope as
            select
                cast(row_number() over (order by z.zone_id) - 1 as integer) as idx,
                {tile_key} as tile_key,
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
        # Via Parquet rather than con.register: handing a polars frame straight
        # to DuckDB goes through Arrow and so needs pyarrow, a large dependency
        # for one 1.6M-row handoff. Both sides speak Parquet natively.
        index_path = out / "_previous_index.parquet"
        previous.write_parquet(index_path)
        con.execute(
            f"create or replace temp view previous_index as "
            f"select * from read_parquet('{index_path.as_posix()}')"
        )
        con.execute(f"""
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
                   {tile_key} as tile_key,
                   z.zone_id, z.zone_name, z.latitude, z.longitude, z.region_id, z.country_id
            from assigned a join dim_zone z on z.zone_id = a.zone_id
        """)
        added = con.execute("select count(*) from scope").fetchone()[0] - previous.height
        if added:
            log.info("  %s zones appended to the stable index", f"{added:,}")
        # scope is a table, not a view, so the handoff file has done its job.
        index_path.unlink(missing_ok=True)

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


def _pack(
    data: dict[str, np.ndarray],
    columns: dict[str, str],
    delta: frozenset[str] = frozenset(),
) -> tuple[bytes, list[list[Any]]]:
    """Concatenate the named columns back to back and return them with a schema.

    Columns named in `delta` are stored as successive differences. Sorted index
    columns become long runs of small numbers, which gzip squeezes hard: 5.7x
    on a checkpoint versus 3.2x for gzip alone, and losslessly - better than
    quantising the counts, which costs precision for less.
    """
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

    return bytes(payload), spec


def _write_columnar(
    path: Path,
    sql: str,
    columns: dict[str, str],
    con: duckdb.DuckDBPyConnection,
    delta: frozenset[str] = frozenset(),
) -> dict[str, Any]:
    """Run `sql`, pack the named columns into one gzip file, return a manifest entry.

    Output is gzip because browsers decompress it natively through
    DecompressionStream, so the client needs no library.
    """
    data = con.execute(sql).fetchnumpy()
    rows = len(next(iter(data.values()))) if data else 0
    payload, spec = _pack(data, columns, delta)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(payload, 6))

    return {
        "path": path.name,
        "rows": int(rows),
        "columns": spec,
        "bytes": path.stat().st_size,
        "raw_bytes": len(payload),
    }


def _write_tiled(
    directory: Path,
    sql: str,
    columns: dict[str, str],
    con: duckdb.DuckDBPyConnection,
    delta: frozenset[str] = frozenset(),
) -> tuple[dict[str, list[int]], list[list[Any]] | None, int]:
    """Run one query and split its rows into a file per tile.

    `sql` must select `tile_key` and order by it first, so each tile's rows are
    contiguous and the split is a slice rather than a scan. Splitting here
    instead of running a query per tile keeps this at one query per time
    period - roughly 190 in total, the same as the untiled export.

    Returns the per-tile {rows, bytes} manifest, the shared column schema, and
    the total unpacked size.
    """
    data = con.execute(sql).fetchnumpy()
    keys = np.asarray(data.pop("tile_key"))
    if not len(keys):
        return {}, None, 0

    # The query is ordered by tile_key, so np.unique's first-occurrence indices
    # are exactly the group boundaries.
    unique, starts = np.unique(keys, return_index=True)
    edges = [*starts.tolist(), len(keys)]

    shards: dict[str, list[int]] = {}
    schema: list[list[Any]] | None = None
    raw_total = 0

    directory.mkdir(parents=True, exist_ok=True)
    for i, key in enumerate(unique.tolist()):
        lo, hi = edges[i], edges[i + 1]
        payload, spec = _pack({k: v[lo:hi] for k, v in data.items()}, columns, delta)
        # Every shard of a kind has the same schema, so the manifest carries it
        # once rather than repeating it across thousands of entries.
        if schema is None:
            schema = spec
        elif spec != schema:
            raise AssertionError(f"{directory} shard schemas diverged: {spec} != {schema}")

        name = _tile_name(key)
        path = directory / f"{name}.bin.gz"
        path.write_bytes(gzip.compress(payload, 6))
        shards[name] = [hi - lo, path.stat().st_size]
        raw_total += len(payload)

    return shards, schema, raw_total


def _clear_shards(out: Path) -> None:
    """Drop the previous run's shard trees so nothing stale survives a reshard.

    Safe to do unconditionally: an immutable shard is rewritten byte-for-byte,
    which git records as no change at all. It runs *after* the stable index has
    been recovered from zones.bin.gz, which is deliberately left in place.
    """
    for name in ("checkpoints", "events", "series"):
        shutil.rmtree(out / name, ignore_errors=True)


def _export_lookups(con: duckdb.DuckDBPyConnection, out: Path) -> dict[str, Any]:
    """Region and country names, so the client can label a zone.

    Small enough to be one file: 251 countries and 3,799 regions. Keyed by id
    because `zones.bin.gz` stores the ids, not the strings -- 1.6M repeated
    country names would dwarf everything else in the export.
    """
    countries = {
        str(row[0]): [row[1], row[2]]
        for row in con.execute(
            "select country_id, country_code, country_name from stg_countries order by 1"
        ).fetchall()
    }
    regions = {
        str(row[0]): [row[2], row[1]]
        for row in con.execute(
            "select region_id, country_id, region_name from stg_regions order by 1"
        ).fetchall()
    }
    payload = {
        "countries": countries,  # id -> [iso_code, name]
        "regions": regions,  # id -> [name, country_id]
        "note": (
            "A zone's country_id is authoritative. Where regions[region_id][1] disagrees "
            "with it the region is wrong, not the country -- verified against coordinates. "
            "Suppress the region label in that case."
        ),
    }
    size = _write_json_gz(out / "lookups.json.gz", payload)
    log.info("lookups: %d countries, %d regions, %s KB", len(countries), len(regions), size // 1024)
    return {"path": "lookups.json.gz", "bytes": size, "countries": len(countries), "regions": len(regions)}


def _export_zones(con: duckdb.DuckDBPyConnection, out: Path) -> dict[str, Any]:
    """Static geometry and administrative ids, index-aligned.

    Not tiled: every view needs positions to place anything at all, and the
    file compresses well enough that splitting it would cost more in requests
    than it saves in bytes.

    `region_id` and `country_id` ride along as uint16 rather than being looked
    up per zone at runtime. They sort into long runs -- region ids are grouped
    by country upstream, and the index is zone_id order -- so gzip gives them
    away nearly free.
    """
    entry = _write_columnar(
        out / "zones.bin.gz",
        "select idx, zone_id, latitude, longitude, region_id, country_id from scope order by idx",
        {
            "latitude": "float32",
            "longitude": "float32",
            "zone_id": "int32",
            "region_id": "uint16",
            "country_id": "uint16",
        },
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


def _export_tiles(con: duckdb.DuckDBPyConnection) -> dict[str, dict[str, Any]]:
    """The tile directory: what exists, how big, and where it is on the map."""
    rows = con.execute(
        "select tile_key, count(*) from scope group by 1 order by 1"
    ).fetchall()
    return {
        _tile_name(int(key)): {"zones": int(count), "bbox": _tile_bbox(int(key))}
        for key, count in rows
    }


def _export_checkpoints(
    con: duckdb.DuckDBPyConnection, out: Path
) -> tuple[dict[str, dict[str, list[int]]], list[list[Any]] | None, int]:
    """Dense year-boundary snapshots, one file per (boundary, tile)."""
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

    manifest: dict[str, dict[str, list[int]]] = {}
    schema: list[list[Any]] | None = None
    raw_total = 0
    for year in years:
        shards, spec, raw = _write_tiled(
            out / "checkpoints" / str(year),
            f"""
            select s.tile_key, s.idx,
                   c.control_state, c.legion_count, c.swarm_count, c.faceless_count
            from fct_zone_checkpoints c
            join scope s on s.zone_id = c.zone_id
            where c.checkpoint_date = date '{year}-01-01'
            order by s.tile_key, s.idx
            """,
            CHECKPOINT_COLUMNS,
            con,
            delta=frozenset({"idx"}),
        )
        if shards:
            manifest[str(year)] = shards
            schema = schema or spec
            raw_total += raw

    files = sum(len(shards) for shards in manifest.values())
    size = sum(entry[1] for shards in manifest.values() for entry in shards.values())
    log.info("  checkpoints: %d boundaries, %s files, %s MB", len(manifest), f"{files:,}", f"{size / 1e6:.1f}")
    return manifest, schema, raw_total


def _export_events(
    con: duckdb.DuckDBPyConnection, out: Path
) -> tuple[dict[str, dict[str, list[int]]], list[list[Any]] | None, int]:
    """Event streams, sharded by month and tile.

    Monthly rather than yearly so nightly updates stay cheap to commit: only
    the current month's shards are rewritten and every earlier one is
    immutable, so git stores each month once instead of once per night.

    Within a shard, rows group by zone rather than running in global timestamp
    order. Grouping a zone's trajectory together is what makes the stream
    compress - 4x versus 3.1x for timestamp order - and the client rebuilds a
    day index on load in milliseconds.

    The tiebreak is `observed_at`, not `activity_date`. 653,071 zone-days carry
    more than one event, so ordering by the date alone leaves them tied and
    DuckDB's parallel sort emits them in whatever order it finishes in. That
    made the output nondeterministic between identical runs -- 945 shards
    differed -- and, worse, wrong: the client takes the last row in file order
    as the zone's state for that day, so an arbitrary order can surface an
    earlier observation as the day's outcome. (zone_id, observed_at) is unique
    across all 9.87M rows, so this is a total order.
    """
    months = con.execute("""
        select distinct year(e.activity_date) as y, month(e.activity_date) as m
        from fct_zone_events e join scope s on s.zone_id = e.zone_id
        order by 1, 2
    """).fetchall()

    manifest: dict[str, dict[str, list[int]]] = {}
    schema: list[list[Any]] | None = None
    raw_total = 0
    for year, month in months:
        shards, spec, raw = _write_tiled(
            out / "events" / f"{year:04d}-{month:02d}",
            f"""
            select
                s.tile_key,
                s.idx,
                cast(date_diff('day', date '{config.DAY_EPOCH}', e.activity_date) as integer) as day,
                e.control_state, e.legion_count, e.swarm_count, e.faceless_count
            from fct_zone_events e
            join scope s on s.zone_id = e.zone_id
            where year(e.activity_date) = {year} and month(e.activity_date) = {month}
            order by s.tile_key, s.idx, e.observed_at
            """,
            EVENT_COLUMNS,
            con,
            delta=frozenset({"idx"}),
        )
        if shards:
            manifest[f"{year:04d}-{month:02d}"] = shards
            schema = schema or spec
            raw_total += raw

    rows = sum(entry[0] for shards in manifest.values() for entry in shards.values())
    files = sum(len(shards) for shards in manifest.values())
    size = sum(entry[1] for shards in manifest.values() for entry in shards.values())
    log.info(
        "  events: %s rows, %d months, %s files, %s MB",
        f"{rows:,}", len(manifest), f"{files:,}", f"{size / 1e6:.1f}",
    )
    return manifest, schema, raw_total


def _sparse_series(con: duckdb.DuckDBPyConnection, sql: str) -> dict[str, Any]:
    """Keep only rows where a faction total moved. The client steps forward."""
    rows = con.execute(sql).fetchall()
    return {
        "columns": SERIES_COLUMNS,
        "rows": [[int(value) for value in row] for row in rows],
    }


def _write_json_gz(path: Path, payload: Any) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(json.dumps(payload, separators=(",", ":")).encode("utf-8"), 6))
    return path.stat().st_size


def _export_tile_series(con: duckdb.DuckDBPyConnection, out: Path) -> dict[str, Any]:
    """Sparse daily faction totals per tile. Two files, every tile in both.

    This carries the whole low-zoom view. It is what the viewport chart sums,
    and it is also what the map draws below the detail threshold: one mark per
    tile, so a world view needs no per-zone data at all and never touches
    `zones.bin.gz` or a single event shard.

    It is also what makes tiling safe for the chart. Summing a per-tile series
    needs no per-zone history, so a zone whose earlier events live in a tile
    the viewer never loaded cannot book its whole lifetime as one day's change.
    Sum the visible tiles and the answer is exact.

    One combined file rather than one per tile: the client wants all 127 up
    front for the overview, and 127 requests to assemble 1.5 MB is worse on
    every axis than one request. Split at the current year so the immutable
    past is fetched once and only the small current-year file churns nightly --
    gzip output changes wholesale with its input, so git cannot delta a
    rewritten file.
    """
    day = f"cast(date_diff('day', date '{config.DAY_EPOCH}', activity_date) as integer)"
    data = con.execute(f"""
        with daily as (
            select s.tile_key, e.activity_date,
                   sum(e.legion_delta)   as legion_delta,
                   sum(e.swarm_delta)    as swarm_delta,
                   sum(e.faceless_delta) as faceless_delta
            from fct_zone_events e join scope s on s.zone_id = e.zone_id
            group by 1, 2
        ),
        cumulative as (
            select tile_key, activity_date,
                   legion_delta, swarm_delta, faceless_delta,
                   sum(legion_delta)   over w as legion,
                   sum(swarm_delta)    over w as swarm,
                   sum(faceless_delta) over w as faceless
            from daily
            window w as (
                partition by tile_key order by activity_date
                rows between unbounded preceding and current row
            )
        )
        select tile_key, {day} as day, year(activity_date) as year, legion, swarm, faceless
        from cumulative
        where legion_delta != 0 or swarm_delta != 0 or faceless_delta != 0
        order by tile_key, activity_date
    """).fetchnumpy()

    current_year = date.today().year
    keys = np.asarray(data["tile_key"])
    if not len(keys):
        return {}

    unique, starts = np.unique(keys, return_index=True)
    edges = [*starts.tolist(), len(keys)]
    years = np.asarray(data["year"])
    values = np.stack(
        [np.asarray(data[name]) for name in ("day", "legion", "swarm", "faceless")], axis=1
    ).astype("int64")

    split: dict[str, dict[str, list[list[int]]]] = {"base": {}, "current": {}}
    for i, key in enumerate(unique.tolist()):
        lo, hi = edges[i], edges[i + 1]
        name = _tile_name(key)
        rows, is_past = values[lo:hi], years[lo:hi] < current_year
        for label, subset in (("base", rows[is_past]), ("current", rows[~is_past])):
            if len(subset):
                split[label][name] = subset.tolist()

    manifest: dict[str, Any] = {}
    for label, tiles in split.items():
        if not tiles:
            continue
        name = "tiles.json.gz" if label == "base" else f"tiles.{current_year}.json.gz"
        size = _write_json_gz(
            out / "series" / name, {"columns": SERIES_COLUMNS, "tiles": tiles}
        )
        manifest[label] = {"path": f"series/{name}", "bytes": size, "tiles": len(tiles)}

    log.info(
        "  series tiles: %d tiles, %s KB across %d files",
        len(unique),
        f"{sum(part['bytes'] for part in manifest.values()) // 1024:,}",
        len(manifest),
    )
    return manifest


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
        "columns": SERIES_COLUMNS,
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

    written: dict[str, Any] = {}
    for name, payload in (
        ("global_daily", global_series),
        ("scope_daily", scope_series),
        ("country_daily", country_series),
    ):
        path = out / "series" / f"{name}.json.gz"
        size = _write_json_gz(path, payload)
        written[name] = {"path": f"series/{name}.json.gz", "bytes": size}
        log.info("  series %s: %s KB", name, size // 1024)

    written["tiles"] = _export_tile_series(con, out)
    return written


def export_all(scope_name: str | None = None, out: Path | None = None) -> None:
    scope = config.SCOPES[scope_name or config.DEFAULT_SCOPE]
    out = out or (config.WEB_DATA / scope.name)
    out.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect(str(config.DUCKDB_PATH), read_only=True)
    try:
        zone_count = _create_scope(con, scope, out)
        log.info("scope %s: %s zones", scope.name, f"{zone_count:,}")

        _clear_shards(out)
        lookups = _export_lookups(con, out)
        zones = _export_zones(con, out)
        log.info("zones: %s KB (+ %s KB names)", zones["bytes"] // 1024, zones["names"]["bytes"] // 1024)

        tiles = _export_tiles(con)
        log.info("tiles: %d populated at zoom %d", len(tiles), config.TILE_ZOOM)

        checkpoints, checkpoint_schema, checkpoint_raw = _export_checkpoints(con, out)
        events, event_schema, event_raw = _export_events(con, out)
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
            "lookups": lookups,
            "tiling": {
                "zoom": config.TILE_ZOOM,
                "scheme": "xyz",
                "key": "{x}-{y}",
                "note": (
                    "Standard web-mercator tiles. A tile's bbox is listed so the client "
                    "can intersect the viewport without reimplementing the projection."
                ),
            },
            "tiles": tiles,
            # Hoisted out of the shards: every checkpoint file shares one schema
            # and every event file another, so repeating them across thousands
            # of manifest entries would dwarf the manifest itself.
            "schemas": {"checkpoint": checkpoint_schema, "event": event_schema},
            "checkpoints": checkpoints,
            "events": events,
            "series": series,
            "encoding": {
                "container": "gzip",
                "shard_entry": "[rows, bytes]; a missing tile key means that shard is empty",
                "checkpoint_path": "checkpoints/{year}/{x}-{y}.bin.gz",
                "event_path": "events/{year}-{month}/{x}-{y}.bin.gz",
                "note": (
                    "Every .gz is a gzip stream over a columnar dump: each column is a "
                    "contiguous run of one fixed-width dtype, concatenated in the order "
                    "'schemas' lists it. Decompress with DecompressionStream('gzip'), then "
                    "take typed-array views at the running offsets. A column marked 'delta' "
                    "holds successive differences; prefix-sum it to recover values."
                ),
                "event_order": "(zone idx, day) - build a day index on load, not file order",
                "idx_scope": (
                    "idx is global and stable across tiles, not per-tile. Tiled shards "
                    "index into one flat array; never renumber within a tile."
                ),
            },
            "notes": [
                "Series are sparse: carry the previous value forward across gaps.",
                "Sum per-tile series for a viewport chart. Do not delta-walk per-zone "
                "events across tiles - a zone with history in an unloaded tile would "
                "book its whole lifetime as one day's change.",
                "2019 has an upstream collection gap and is not a real lull.",
                "Bot counts before 2012-05 are the backfill baseline, not observations.",
            ],
        }
        # Compact, not indented. The shard manifest is over ten thousand
        # entries; pretty-printing it triples the file for nobody's benefit,
        # since nothing that size gets read by eye anyway.
        (out / "meta.json").write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")

        shard_bytes = sum(
            entry[1]
            for group in (checkpoints, events)
            for shards in group.values()
            for entry in shards.values()
        )
        shard_files = sum(len(shards) for group in (checkpoints, events) for shards in group.values())
        series_files = [series[name] for name in ("global_daily", "scope_daily", "country_daily")]
        series_files += list(series["tiles"].values())

        total = (
            shard_bytes
            + zones["bytes"]
            + zones["names"]["bytes"]
            + sum(entry["bytes"] for entry in series_files)
        )
        raw = checkpoint_raw + event_raw + zones["raw_bytes"]
        log.info(
            "export complete: %s MB across %s files (%.1fx smaller than raw)",
            f"{total / 1e6:.1f}",
            f"{shard_files + len(series_files) + 3:,}",  # + zones, names, meta
            raw / shard_bytes if shard_bytes else 0,
        )
    finally:
        con.close()
