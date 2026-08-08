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
import shutil
from pathlib import Path
from typing import Any

import brotli
import duckdb
import numpy as np
import polars as pl

from . import config

log = logging.getLogger(__name__)

# Brotli, not gzip, and decompressed by the browser rather than by us.
#
# Every payload is stored compressed and served with `Content-Encoding: br`, so
# `fetch(...).arrayBuffer()` hands back the raw bytes and the client carries no
# decoding code. Measured against the gzip it replaces: geometry 10.44 -> 8.53
# MB, 18% off, and that is before the decompression work leaves the main thread.
#
# Two qualities, because the curve has a knee. On the 2026 checkpoint (26.9 MB
# raw, 4.13 MB at gzip 6):
#
#   q5    4.07 MB    1.1s
#   q9    3.93 MB    4.5s
#   q10   3.60 MB   46.2s
#   q11   3.43 MB  130.3s
#
# q11 for everything on the critical path, where every kilobyte is in front of
# a reader waiting for the map. q10 for the history bulk, which streams in the
# background long after the page is usable: it gives up 4% of the ratio to save
# most of the export's running time. Decompression is fast at every level.
BROTLI_QUALITY = 11
BROTLI_QUALITY_BULK = 10


def _write(path: Path, payload: bytes, quality: int = BROTLI_QUALITY) -> int:
    """Write one brotli-compressed artifact and return its size on the wire."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(brotli.compress(payload, quality=quality))
    return path.stat().st_size

# Column dtypes, chosen to be the narrowest that cannot overflow.
#   idx     - dense 0..N-1 index into zones.bin, not the sparse upstream ZoneId
#   day     - days since config.DAY_EPOCH
#   faction - 0 uncaptured, 1 legion, 2 swarm, 3 faceless
IDX = "uint32"
DAY = "uint16"
FACTION = "uint8"
COUNT = "int32"

_ITEMSIZE = {"uint8": 1, "uint16": 2, "uint32": 4, "int32": 4, "float32": 4}

# Geometry grid. Bigger tiles compress better, because each one restarts the
# delta runs: lat+lon+idx measured 6.88 MB at 2 degrees, 6.04 at 4, 5.56 at 8.
#
# 16, not 8, because the binding constraint turned out to be *requests* rather
# than bytes. A cold load was 1,659 of them, and the data is served from an
# r2.dev URL with no CDN in front, which is rate-limited and documented as not
# for production traffic. 16 degrees takes the world from 474 populated tiles to
# about 150 and compresses slightly better on top. What it costs is precision in
# the nearest-first ordering: the first tile to land is four times the area, so
# "near the reader" is a coarser claim than it was.
TILE_DEGREES = 16

# Fixed-point coordinates, 1e-4 degrees ~ 11 m. A zone is about a kilometre
# across, so this is well inside the noise. 1e-3 (111 m) saves another 0.6 MB
# but visibly collapses neighbouring zones onto each other when zoomed in.
COORD_SCALE = 10_000


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
        filters.append("zone_id in (select zone_id from zone_events)")

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
        # Via Parquet rather than con.register: handing a polars frame straight
        # to DuckDB goes through Arrow and so needs pyarrow, a large dependency
        # for one 1.6M-row handoff. Both sides speak Parquet natively.
        index_path = out / "_previous_index.parquet"
        previous.write_parquet(index_path)
        con.execute(
            f"create or replace temp view previous_index as "
            f"select * from read_parquet('{index_path.as_posix()}')"
        )
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
        # scope is a table, not a view, so the handoff file has done its job.
        index_path.unlink(missing_ok=True)

    return con.execute("select count(*) from scope").fetchone()[0]


def _previous_index(out: Path) -> pl.DataFrame | None:
    """Recover the zone_id -> idx assignment from a prior export.

    zone_ids.bin.br is zone_id at every index, in index order, so it is its own
    index manifest and there is no second file to keep in sync.
    """
    meta_path, ids_path = out / "meta.json", out / "zone_ids.bin.br"
    if not (meta_path.exists() and ids_path.exists()):
        return None

    entry = json.loads(meta_path.read_text()).get("zone_ids")
    if entry is None:
        return None
    rows = entry["rows"]
    _, dtype, encoding = entry["columns"][0]
    zone_ids = np.frombuffer(brotli.decompress(ids_path.read_bytes()), dtype=dtype, count=rows)
    if encoding == "delta":
        zone_ids = np.cumsum(zone_ids.astype("int64")).astype("int32")
    return pl.DataFrame({"zone_id": zone_ids, "idx": np.arange(rows, dtype="int32")})


def _pack(
    data: dict[str, np.ndarray],
    columns: dict[str, str],
    delta: frozenset[str] = frozenset(),
) -> tuple[bytes, list[list[Any]], int]:
    """Dump the named columns back to back and return (payload, spec, rows).

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
            # An unsigned column cannot carry a negative difference, so for those
            # the encoding doubles as an assertion that the column is sorted.
            # Signed columns are allowed to go backwards: the geometry tiles are
            # in spatial order, where longitude resets at every row of latitude
            # and idx jumps around, and those deltas are still far smaller than
            # the absolute values they replace.
            if dtype.startswith("uint") and column.min() < 0:
                raise ValueError(f"{name} must be sorted ascending to delta-encode")
            encoding = "delta"

        payload += np.ascontiguousarray(column, dtype=dtype).tobytes()
        spec.append([name, dtype, encoding])

    return bytes(payload), spec, int(rows)


def _write_columnar(
    path: Path,
    sql: str,
    columns: dict[str, str],
    con: duckdb.DuckDBPyConnection,
    delta: frozenset[str] = frozenset(),
    quality: int = BROTLI_QUALITY,
) -> dict[str, Any]:
    """Run `sql`, pack the named columns, compress, return a manifest entry."""
    payload, spec, rows = _pack(con.execute(sql).fetchnumpy(), columns, delta)
    return {
        "path": path.name,
        "rows": rows,
        "columns": spec,
        "bytes": _write(path, payload, quality),
        "raw_bytes": len(payload),
    }


def _years(con: duckdb.DuckDBPyConnection, table: str, column: str) -> list[int]:
    return [
        int(row[0])
        for row in con.execute(f"""
            select distinct year({column}) from {table} t
            join scope s on s.zone_id = t.zone_id order by 1
        """).fetchall()
    ]


def _clear_shards(out: Path) -> None:
    """Drop the previous run's shard trees so nothing stale survives a change.

    Safe to do unconditionally: an unchanged shard is rewritten byte-for-byte.
    It runs *after* the stable index has been recovered from zone_ids.bin.br,
    which is deliberately left in place.

    Not paranoia. Switching the layout left 187 orphaned directories and 12,000
    files behind, all of them still being served.
    """
    for name in (
        "display",
        "zone_history",
        "series",
        "tiles",
        "terrain",
        "paint",
        "names",
    ):
        shutil.rmtree(out / name, ignore_errors=True)
    # Layouts this replaced. Left behind, they are dead weight that an upload
    # sync would keep serving to anyone holding a stale manifest.
    for stale_tree in ("geometry", "checkpoints", "events"):
        shutil.rmtree(out / stale_tree, ignore_errors=True)
    for stale in ("zones.bin.gz", "zone_names.json.gz", "zone_ids.bin.gz", "lookups.json.gz"):
        (out / stale).unlink(missing_ok=True)


def _write_json(path: Path, payload: Any) -> int:
    return _write(path, json.dumps(payload, separators=(",", ":")).encode("utf-8"))


def _export_lookups(con: duckdb.DuckDBPyConnection, out: Path) -> dict[str, Any]:
    """Region and country names, so the client can say where a zone is.

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
    size = _write_json(
        out / "lookups.json.br",
        {
            "countries": countries,  # id -> [iso_code, name]
            "regions": regions,  # id -> [name, country_id]
            "note": (
                "A zone's country_id is authoritative. Where regions[region_id][1] "
                "disagrees with it the region is wrong, not the country -- verified "
                "against coordinates. Suppress the region label in that case."
            ),
        },
    )
    log.info("lookups: %d countries, %d regions, %s KB", len(countries), len(regions), size // 1024)
    return {
        "path": "lookups.json.br",
        "bytes": size,
        "countries": len(countries),
        "regions": len(regions),
    }


def _export_zone_ids(con: duckdb.DuckDBPyConnection, out: Path) -> dict[str, Any]:
    """Upstream `ZoneId` at every index, in index order.

    Its own file for two reasons. It is the export's index manifest, which is
    how the next run recovers the permanent idx assignment. And the viewer
    needs it only to print "#1529645" on hover, so keeping it out of the
    geometry means it never delays a single dot.

    Delta-encoded, which is nearly free here: index order *is* zone_id order,
    so the differences are 1s and 2s. Measured 4.21 MB -> 0.48 MB.
    """
    entry = _write_columnar(
        out / "zone_ids.bin.br",
        "select zone_id from scope order by idx",
        {"zone_id": "int32"},
        con,
        delta=frozenset({"zone_id"}),
    )
    log.info("zone ids: %s KB", entry["bytes"] // 1024)
    return entry


# The map draws a dot from two facts: who holds the zone, and how big to make
# it. Radius is log10(count) capped in pixels, so a few bits carry far more
# resolution than the screen has. 0 means empty; 1..63 are log buckets.
#
# Six bits, not eight, so a faction and a size fit in one byte together. That
# byte is the unit the whole history is stored in - see _export_display - and
# halving it halves 15 MB. The cost is resolution the screen cannot show: at
# eight steps per decade a bucket spans a 33% change in bot count, and the
# radius it maps to moves by about 140 m against a 600-8400 m range.
_MAGNITUDE_STEPS = 8
_MAGNITUDE_MAX = 63


def _magnitude(total: np.ndarray) -> np.ndarray:
    bucket = 1 + np.rint(np.log10(np.maximum(total, 0) + 1) * _MAGNITUDE_STEPS)
    return np.where(total > 0, np.minimum(bucket, _MAGNITUDE_MAX), 0).astype("uint8")


# A zone's colour is the faction with the most bots standing in it - not
# `control_state`, which names whoever captured it last and keeps naming them
# long after their last bot is gone. Colouring by the holder made the map assert
# control that was not there; colouring by the garrison is what a reader looking
# at a dot actually wants to know.
#
# On a tie the holder breaks it, but only when it is one of the tied factions:
# that uses real information rather than an arbitrary rule, and cannot hand the
# zone to a faction with fewer bots than another. A tie among factions the
# holder is not part of falls back to a fixed order, which is arbitrary but rare
# and has to be *something*.
#
# Not to be confused with the thing this file warns about elsewhere: colouring
# by which faction *gained* most over a window. That is a delta, it made the
# colour mean two different things depending on a toggle, and it stays gone.
# This is a level, and it means the same thing in every window.
_LEADER = """
    case
        when {legion} + {swarm} + {faceless} <= 0 then 0
        when {holder} = 1 and {legion} = greatest({legion}, {swarm}, {faceless}) then 1
        when {holder} = 2 and {swarm} = greatest({legion}, {swarm}, {faceless}) then 2
        when {holder} = 3 and {faceless} = greatest({legion}, {swarm}, {faceless}) then 3
        when {legion} = greatest({legion}, {swarm}, {faceless}) then 1
        when {swarm} = greatest({legion}, {swarm}, {faceless}) then 2
        else 3
    end
"""


def _leader(holder: str, legion: str, swarm: str, faceless: str) -> str:
    return _LEADER.format(holder=holder, legion=legion, swarm=swarm, faceless=faceless)


def _pack_display(leader: str, total: str) -> str:
    """Faction in the top two bits, size bucket in the low six.

    An empty zone packs to 0 whoever nominally holds it, which is also how the
    map draws it: with no bots on the ground there is nothing to own.
    """
    return f"""
        case when {total} > 0
             then cast({leader} as integer) * 64
                  + least(1 + cast(round(log10({total} + 1) * {_MAGNITUDE_STEPS}) as integer),
                          {_MAGNITUDE_MAX})
             else 0 end
    """


def _export_geometry(con: duckdb.DuckDBPyConnection, out: Path) -> dict[str, Any]:
    """Zone positions and today's colours, sharded into a spatial grid.

    This is sharding, not level of detail. Every zone is in exactly one tile
    and every tile is eventually fetched; the only thing the grid buys is an
    order. Nothing is ever aggregated away.

    Three files per tile, in the order the viewer needs them:

    - `tiles/` and `paint/` for zones that have ever held a bot. Together they
      are everything needed to draw the played world correctly - about 4.9 MB
      for all 1.6M of them.
    - `terrain/` for the 1.09M zones never touched in fourteen years. They are
      real places and belong on the map, but they are always grey, so they
      carry no paint and load behind everything else.
    - `names/`, needed only when the pointer stops on a dot.

    Two encodings pay for themselves, both measured:

    - Coordinates are quantised to 1e-4 degrees (~11 m, far finer than a zone)
      and delta-encoded, sorted by latitude then longitude within the tile so
      the latitude deltas collapse to runs of zero. float32 mantissas are noise
      and no compressor can touch them. Delta-of-delta was tried and is 11%
      *worse*: zones are not on a lattice.
    - Sorting the tile scrambles idx, so it becomes an explicit signed-delta
      column rather than being implied by row order.
    """
    # The same leader rule the display stream uses. If these two ever disagree
    # the map flickers the moment the reader touches the scrubber, because one
    # is what paint/ drew and the other is what display/ replays.
    leader = _leader(
        "coalesce(e.holder, 0)",
        "coalesce(e.legion, 0)",
        "coalesce(e.swarm, 0)",
        "coalesce(e.faceless, 0)",
    )
    rows = con.execute(f"""
        select s.idx, s.latitude, s.longitude, s.region_id, s.country_id, s.zone_name,
               case when e.zone_id is null then 0 else 1 end as ever_active,
               {leader} as leader,
               coalesce(e.legion, 0) + coalesce(e.swarm, 0)
                 + coalesce(e.faceless, 0) as total_count
        from scope s
        left join (
            -- Current state as the client would reconstruct it: the last event
            -- per zone. Deliberately not dim_zone's current_* columns, which
            -- come from the `zones` table and disagree with the event stream
            -- for 1,429 zones - taking them here would make the first frame
            -- flicker when the exact history finished loading.
            select zone_id,
                   arg_max(control_state, observed_at)  as holder,
                   arg_max(legion_count, observed_at)   as legion,
                   arg_max(swarm_count, observed_at)    as swarm,
                   arg_max(faceless_count, observed_at) as faceless
            from zone_events group by zone_id
        ) e on e.zone_id = s.zone_id
        order by s.idx
    """).fetchnumpy()

    idx = rows["idx"].astype("int64")
    qlat = np.rint(rows["latitude"].astype("float64") * COORD_SCALE).astype("int64")
    qlon = np.rint(rows["longitude"].astype("float64") * COORD_SCALE).astype("int64")
    names = np.asarray(rows["zone_name"], dtype=object)
    played = rows["ever_active"].astype(bool)
    # The same packed byte the display stream stores, so the client has exactly
    # one representation of "what the map draws" and never converts between two.
    display_pk = (
        rows["leader"].astype("uint16") * 64 + _magnitude(rows["total_count"].astype("int64"))
    ).astype("uint8")

    tile_row = np.floor_divide(rows["latitude"] + 90.0, TILE_DEGREES).astype("int64")
    tile_col = np.floor_divide(rows["longitude"] + 180.0, TILE_DEGREES).astype("int64")
    # A zone exactly on the pole or the antimeridian would otherwise land in a
    # tile one past the end of the grid.
    tile_row = np.clip(tile_row, 0, int(180 // TILE_DEGREES))
    tile_col = np.clip(tile_col, 0, int(360 // TILE_DEGREES))

    position_columns = {
        "idx": "int32",
        "latitude": "int32",
        "longitude": "int32",
        "region_id": "uint16",
        "country_id": "uint16",
    }
    paint_columns = {"pk": "uint8"}
    delta = frozenset({"idx", "latitude", "longitude"})

    # One sort for the whole world rather than a full-array scan per tile.
    keys = tile_row * 1000 + tile_col
    order = np.lexsort((qlon, qlat, keys))
    unique, starts = np.unique(keys[order], return_index=True)
    ends = np.append(starts[1:], len(order))

    tiles: list[list[Any]] = []
    position_spec: list[list[Any]] = []
    paint_spec: list[list[Any]] = []

    def pack_positions(member: np.ndarray) -> tuple[bytes, list[list[Any]]]:
        payload, spec, _ = _pack(
            {
                "idx": idx[member],
                "latitude": qlat[member],
                "longitude": qlon[member],
                "region_id": rows["region_id"][member],
                "country_id": rows["country_id"][member],
            },
            position_columns,
            delta,
        )
        return payload, spec

    for key, start, end in zip(unique, starts, ends, strict=True):
        member = order[start:end]
        row, col = int(key // 1000), int(key % 1000)
        name = f"{row:02d}_{col:02d}"

        # Played and unplayed zones split into separate files but keep the tile's
        # sort order within each, so paint rows line up with position rows.
        is_played = played[member]
        played_member = member[is_played]
        terrain_member = member[~is_played]

        entry: dict[str, int] = {}

        if len(played_member):
            payload, position_spec = pack_positions(played_member)
            entry["tile_bytes"] = _write(out / "tiles" / f"{name}.bin.br", payload)
            paint_payload, paint_spec, _ = _pack(
                {"pk": display_pk[played_member]}, paint_columns
            )
            entry["paint_bytes"] = _write(out / "paint" / f"{name}.bin.br", paint_payload)

        if len(terrain_member):
            payload, position_spec = pack_positions(terrain_member)
            entry["terrain_bytes"] = _write(out / "terrain" / f"{name}.bin.br", payload)

        tiles.append([
            name,
            len(played_member),
            len(terrain_member),
            entry.get("tile_bytes", 0),
            entry.get("paint_bytes", 0),
            entry.get("terrain_bytes", 0),
            # South-west corner in degrees. The client derives the rest from
            # tile_degrees rather than carrying four floats per tile.
            row * TILE_DEGREES - 90,
            col * TILE_DEGREES - 180,
        ])

    first_paint = sum(t[3] + t[4] for t in tiles)
    terrain_total = sum(t[5] for t in tiles)
    names_manifest = _export_names(idx, names, out)
    names_total = names_manifest["bytes"]
    log.info(
        "geometry: %d tiles - played %s MB (positions + paint), terrain %s MB, names %s MB",
        len(tiles),
        f"{first_paint / 1e6:.2f}",
        f"{terrain_total / 1e6:.2f}",
        f"{names_total / 1e6:.2f}",
    )
    return {
        "tile_degrees": TILE_DEGREES,
        "coord_scale": COORD_SCALE,
        "magnitude_steps": _MAGNITUDE_STEPS,
        "paths": {"tiles": "tiles", "paint": "paint", "terrain": "terrain"},
        "position_columns": position_spec,
        "paint_columns": paint_spec,
        "tile_fields": [
            "name",
            "played",
            "terrain",
            "tile_bytes",
            "paint_bytes",
            "terrain_bytes",
            "south",
            "west",
        ],
        "tiles": tiles,
        "first_paint_bytes": first_paint,
        "terrain_bytes": terrain_total,
        "names_bytes": names_total,
        # Lifted to meta["names"] by export_all: names are keyed by idx and owe
        # nothing to the tile grid any more.
        "_names": names_manifest,
    }


# Zones per name block. Matches the per-zone history block, so a reader who
# rests on a dot pulls one block of each and both are small.
_NAME_BLOCK = 4096


def _export_names(idx: np.ndarray, names: np.ndarray, out: Path) -> dict[str, Any]:
    """Zone names, sharded by block of zone index.

    **Deliberately not sharded by tile.** Tile order would require writing names
    in the tile's render order - every played row, then every terrain row - so a
    name lines up with the render slot the client assigns as the two position
    files land. That invariant is invisible, easy to break, and its failure mode
    is a hover confidently naming the wrong place.

    Keyed by idx there is no invariant to break: row `i` of block `B` is the
    name of zone `B * 4096 + i`, and nothing about arrival order or tile size
    can change that. It also frees the tile grid to grow without making a name
    fetch expensive - at 16-degree tiles a dense tile-sharded file would be
    ~500 KB against a block's ~19 KB.

    12.6 MB in total, and none of it is fetched until the pointer stops on a
    dot. Dictionary encoding was tested and is worse (10.05 MB vs 8.0 MB on a
    1.6M set): 1.06M of 1.6M names are unique.

    Placed *by* idx rather than by row position. The stable index leaves
    tombstones behind for any zone that ever leaves the scope, so row order and
    idx are only the same thing while nothing has ever left - which is true for
    the global scope today and is not a property worth depending on.
    """
    by_idx = np.full(int(idx.max()) + 1, "", dtype=object)
    by_idx[idx] = names

    total = 0
    blocks: list[list[Any]] = []
    for start in range(0, len(by_idx), _NAME_BLOCK):
        block = start // _NAME_BLOCK
        chunk = [str(n) for n in by_idx[start : start + _NAME_BLOCK]]
        size = _write(
            out / "names" / f"{block:04d}.json.br",
            json.dumps(chunk, ensure_ascii=False).encode("utf-8"),
            BROTLI_QUALITY_BULK,
        )
        blocks.append([block, len(chunk), size])
        total += size

    return {
        "path": "names",
        "block_size": _NAME_BLOCK,
        "block_fields": ["block", "rows", "bytes"],
        "blocks": blocks,
        "bytes": total,
    }


def _prepare_display(con: duckdb.DuckDBPyConnection) -> None:
    """One row per zone-day, carrying only the two facts the map draws.

    The day's outcome is the *last* observation on it by `observed_at`, not by
    `activity_date`: 653,071 zone-days carry more than one event, so ordering
    by the date alone leaves them tied and DuckDB's parallel sort emits them in
    whatever order it finishes in. `arg_max` over `observed_at` is a total
    order across all 9,869,428 rows, which is what makes the export
    deterministic and what makes the day's outcome the right observation.
    """
    # Every arg_max here keys on the same `observed_at`, and (zone_id,
    # observed_at) is unique across all 9.87M rows, so they all pick the same
    # observation rather than mixing columns from different events.
    leader = _leader("holder", "legion", "swarm", "faceless")
    con.execute(f"""
        create or replace temp table display_day as
        with per_day as (
            select s.idx,
                   cast(date_diff('day', date '{config.DAY_EPOCH}', e.activity_date) as integer)
                       as day,
                   arg_max(e.control_state, e.observed_at)   as holder,
                   arg_max(e.legion_count, e.observed_at)    as legion,
                   arg_max(e.swarm_count, e.observed_at)     as swarm,
                   arg_max(e.faceless_count, e.observed_at)  as faceless
            from zone_events e
            join scope s on s.zone_id = e.zone_id
            group by 1, 2
        )
        select idx, day,
               cast({_pack_display(leader, "legion + swarm + faceless")} as utinyint) as pk
        from per_day
    """)


def _export_display(con: duckdb.DuckDBPyConnection, out: Path) -> dict[str, Any]:
    """The whole history of what the map draws, in one byte per zone-day.

    This replaces the checkpoint and event trees on the reading path, and it is
    the point of the whole restructure. Those two were 71.5 MB and every one of
    them had to be in the browser before the reader could move the playhead one
    day, because the client rebuilt exact per-faction counts for 2.68M zones and
    then threw all but a colour and a radius away. Storing what the map actually
    draws is 14.9 MB for fourteen years - and a reader only ever fetches one
    anchor plus one year of it, about 2-3 MB, to land on any date in the record.

    Two trees:

    - `display/anchor_YYYY.bin.br` - every zone holding bots at the start of
      YYYY. Zones absent from it are empty, which is most of the map, so the
      anchor is sparse rather than a dense snapshot of all 2.68M.
    - `display/YYYY.bin.br` - one row for every zone-day in YYYY that saw any
      event at all, whether or not it changed the zone's appearance.

    That last point is deliberate and costs about 2 MB against emitting only
    rows where the packed byte changed. It is what keeps Change mode honest: the
    question "which zones moved this week" is answered by whether a zone had an
    event, not by whether it crossed a log bucket, and a bucket comparison would
    quietly hide every skirmish smaller than a third of a zone's garrison.

    Rows are ordered `(idx, day)`, so idx delta-encodes to long runs of small
    numbers and each zone's trajectory sits together, which is what compresses.
    """
    _prepare_display(con)

    years = [
        int(row[0])
        for row in con.execute(
            f"select distinct cast(date_part('year', "
            f"date '{config.DAY_EPOCH}' + to_days(cast(day as integer))) as integer) "
            f"from display_day order by 1"
        ).fetchall()
    ]

    anchors: list[dict[str, Any]] = []
    shards: list[dict[str, Any]] = []

    for year in years:
        boundary = (
            f"cast(date_diff('day', date '{config.DAY_EPOCH}', date '{year}-01-01') as integer)"
        )

        # An anchor carries only zones that are actually holding something. The
        # client zero-fills first, so an absent zone is an empty one, and by
        # 2026 that is still a million rows saved.
        if year != years[0]:
            entry = _write_columnar(
                out / "display" / f"anchor_{year}.bin.br",
                f"""
                select idx, pk from (
                    select idx, arg_max(pk, day) as pk
                    from display_day where day < {boundary} group by idx
                ) where pk != 0 order by idx
                """,
                {"idx": IDX, "pk": "uint8"},
                con,
                delta=frozenset({"idx"}),
            )
            entry["year"] = year
            anchors.append(entry)

        entry = _write_columnar(
            out / "display" / f"{year}.bin.br",
            f"""
            select idx, day, pk from display_day
            where day >= {boundary}
              and day < cast(date_diff('day', date '{config.DAY_EPOCH}',
                                       date '{year + 1}-01-01') as integer)
            order by idx, day
            """,
            {"idx": IDX, "day": DAY, "pk": "uint8"},
            con,
            delta=frozenset({"idx"}),
            quality=BROTLI_QUALITY_BULK,
        )
        entry["year"] = year
        shards.append(entry)

    anchor_bytes = sum(e["bytes"] for e in anchors)
    shard_bytes = sum(e["bytes"] for e in shards)
    log.info(
        "  display: %s zone-days across %d years - %s MB of deltas, %s MB of anchors. "
        "Landing on a date costs at most %s MB.",
        f"{sum(e['rows'] for e in shards):,}",
        len(shards),
        f"{shard_bytes / 1e6:.1f}",
        f"{anchor_bytes / 1e6:.1f}",
        f"{(max(e['bytes'] for e in shards) + max(e['bytes'] for e in anchors)) / 1e6:.1f}"
        if anchors
        else f"{shard_bytes / 1e6:.1f}",
    )
    return {
        "path": "display",
        "magnitude_steps": _MAGNITUDE_STEPS,
        "pack": "faction = pk >> 6, magnitude = pk & 63; pk 0 is an empty zone",
        "anchors": anchors,
        "shards": shards,
        "anchor_bytes": anchor_bytes,
        "shard_bytes": shard_bytes,
    }


# Zones per per-zone-history block. A block is fetched only when the reader
# rests on a dot or clicks one, so it trades a bigger download against fewer of
# them; 4096 puts a block around 150 KB, which arrives inside a hover.
_HISTORY_BLOCK = 4096


def _export_zone_history(con: duckdb.DuckDBPyConnection, out: Path) -> dict[str, Any]:
    """Exact per-faction counts, sharded by a block of zone indices.

    All 9.88M events, cut by zone rather than by date, so a reader fetches one
    ~35 KB block for the zone they are pointing at rather than the 37 MB whole.
    Nothing on the map needs them - the display stream draws every frame - so
    none of this is on the critical path.

    Ordered `(idx, observed_at)`, which is unique across every row and so a
    total order: the same tiebreak the display stream depends on, for the same
    reason.
    """
    blocks = con.execute(f"""
        select cast(idx / {_HISTORY_BLOCK} as integer) as block, count(*) as events
        from (
            select s.idx from zone_events e join scope s on s.zone_id = e.zone_id
        ) group by 1 order by 1
    """).fetchall()

    entries = []
    for block, _ in blocks:
        entry = _write_columnar(
            out / "zone_history" / f"{block:04d}.bin.br",
            f"""
            select s.idx,
                   cast(date_diff('day', date '{config.DAY_EPOCH}', e.activity_date) as integer)
                       as day,
                   e.control_state, e.legion_count, e.swarm_count, e.faceless_count
            from zone_events e
            join scope s on s.zone_id = e.zone_id
            where s.idx >= {block * _HISTORY_BLOCK}
              and s.idx <  {(block + 1) * _HISTORY_BLOCK}
            order by s.idx, e.observed_at
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
            quality=BROTLI_QUALITY_BULK,
        )
        entry["block"] = int(block)
        entries.append(entry)

    total = sum(e["bytes"] for e in entries)
    log.info(
        "  zone history: %s events in %d blocks of %d zones, %s MB total, %s KB median block",
        f"{sum(e['rows'] for e in entries):,}",
        len(entries),
        _HISTORY_BLOCK,
        f"{total / 1e6:.1f}",
        f"{int(np.median([e['bytes'] for e in entries])) // 1024}" if entries else "0",
    )
    return {
        "path": "zone_history",
        "block_size": _HISTORY_BLOCK,
        "columns": entries[0]["columns"] if entries else [],
        "blocks": [[e["block"], e["rows"], e["bytes"]] for e in entries],
        "block_fields": ["block", "rows", "bytes"],
        "bytes": total,
    }


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
            from zone_events e join scope s on s.zone_id = e.zone_id
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

    written = {}
    for name, payload in (
        ("global_daily", global_series),
        ("scope_daily", scope_series),
    ):
        path = out / "series" / f"{name}.json.br"
        written[name] = {"path": f"series/{name}.json.br", "bytes": _write_json(path, payload)}
        log.info("  series %s: %s KB", name, path.stat().st_size // 1024)
    return written


# The grid the viewport and near-me charts aggregate over. One degree is about
# 111 km, so the 1000-mile circle the game talks in covers roughly 600 cells and
# only its rim is approximate. Cells are grouped into the same 8-degree tiles the
# geometry uses, 64 to a tile, so the chart fetches the same shards the map does.
_CELL_DEGREES = 1
_CELLS_PER_TILE = TILE_DEGREES // _CELL_DEGREES

# The cell index within a tile is a uint8, and at 16-degree tiles the largest is
# 15 * 16 + 15 = 255 - exactly the last value that fits. Widening the tile grid
# again would wrap it silently into a plausible-looking neighbouring cell, which
# is the same failure mode `_pack` guards `day` against.
if _CELLS_PER_TILE**2 > 256:
    raise ValueError(
        f"{_CELLS_PER_TILE**2} cells per tile does not fit a uint8 cell index; "
        f"widen the column or shrink TILE_DEGREES"
    )


def _export_area_series(con: duckdb.DuckDBPyConnection, out: Path) -> dict[str, Any]:
    """Daily faction totals per country, per region, and per one-degree cell.

    This is what keeps the exact event stream out of the browser. Computing a
    chart over some subset of zones on the client means holding all 9.88M events
    in memory and walking them on every filter change; three precomputed grains
    answer the same questions in about 10 MB, and answer them instantly.

    Stored as per-day *deltas*, not running totals. A delta is a small number
    that compresses; a running total is a seven-digit one that does not. The
    client prefix-sums per area, which is the same carry-forward the dbt layer
    does and is what keeps dormant areas correct for free.

    Rows are sparse - a day with no movement in an area has no row - so an area
    that went quiet in 2019 costs nothing until the reader asks for it.
    """
    day = f"cast(date_diff('day', date '{config.DAY_EPOCH}', e.activity_date) as integer)"
    moved = (
        "having sum(e.legion_delta) != 0 or sum(e.swarm_delta) != 0 "
        "or sum(e.faceless_delta) != 0"
    )
    columns = {
        "area_id": "uint16",
        "day": DAY,
        "legion": COUNT,
        "swarm": COUNT,
        "faceless": COUNT,
    }

    country = _write_columnar(
        out / "series" / "country.bin.br",
        f"""
        select e.country_id as area_id, {day} as day,
               sum(e.legion_delta) as legion, sum(e.swarm_delta) as swarm,
               sum(e.faceless_delta) as faceless
        from zone_events e join scope s on s.zone_id = e.zone_id
        where e.country_id is not null
        group by 1, 2 {moved}
        order by 1, 2
        """,
        columns,
        con,
    )

    # A region only counts zones whose country agrees with it. For 447 zones the
    # region's own country contradicts the zone's, and the coordinates side with
    # the country every time - 155 zones filed under a Polish voivodeship sit in
    # the Solomon Islands. The join drops those rather than charting a region
    # that reaches across an ocean, which is the same rule the map's area filter
    # applies.
    region = _write_columnar(
        out / "series" / "region.bin.br",
        f"""
        select e.region_id as area_id, {day} as day,
               sum(e.legion_delta) as legion, sum(e.swarm_delta) as swarm,
               sum(e.faceless_delta) as faceless
        from zone_events e
        join scope s on s.zone_id = e.zone_id
        join stg_regions r on r.region_id = e.region_id and r.country_id = e.country_id
        group by 1, 2 {moved}
        order by 1, 2
        """,
        columns,
        con,
    )

    con.execute(f"""
        create or replace temp view cell_member as
        select s.zone_id,
               least(greatest(cast(floor((s.latitude + 90) / {TILE_DEGREES}) as integer), 0),
                     {180 // TILE_DEGREES}) as trow,
               least(greatest(cast(floor((s.longitude + 180) / {TILE_DEGREES}) as integer), 0),
                     {360 // TILE_DEGREES}) as tcol,
               cast(floor(s.latitude + 90)  as integer) % {_CELLS_PER_TILE} * {_CELLS_PER_TILE}
             + cast(floor(s.longitude + 180) as integer) % {_CELLS_PER_TILE} as cell
        from scope s
    """)

    cells = con.execute(f"""
        select c.trow, c.tcol, c.cell, {day} as day,
               sum(e.legion_delta) as legion, sum(e.swarm_delta) as swarm,
               sum(e.faceless_delta) as faceless
        from zone_events e
        join scope s on s.zone_id = e.zone_id
        join cell_member c on c.zone_id = e.zone_id
        group by 1, 2, 3, 4 {moved}
        order by 1, 2, 3, 4
    """).fetchnumpy()

    cell_columns = {"cell": "uint8", "day": DAY, "legion": COUNT, "swarm": COUNT, "faceless": COUNT}
    keys = cells["trow"].astype("int64") * 1000 + cells["tcol"].astype("int64")
    unique, starts = np.unique(keys, return_index=True)
    ends = np.append(starts[1:], len(keys))

    cell_shards: list[list[Any]] = []
    cell_spec: list[list[Any]] = []
    for key, start, end in zip(unique, starts, ends, strict=True):
        name = f"{int(key // 1000):02d}_{int(key % 1000):02d}"
        payload, cell_spec, rows = _pack(
            {n: cells[n][start:end] for n in cell_columns}, cell_columns
        )
        cell_shards.append([
            name,
            rows,
            _write(out / "series" / "cells" / f"{name}.bin.br", payload, BROTLI_QUALITY_BULK),
        ])

    cell_bytes = sum(shard[2] for shard in cell_shards)
    log.info(
        "  area series: country %s KB, region %s KB, cells %s MB across %d tiles",
        country["bytes"] // 1024,
        region["bytes"] // 1024,
        f"{cell_bytes / 1e6:.2f}",
        len(cell_shards),
    )
    return {
        "note": (
            "Per-day deltas, sparse. Prefix-sum within an area to recover running "
            "totals, carrying the last value forward across days with no row."
        ),
        "country": {**country, "path": "series/country.bin.br"},
        "region": {**region, "path": "series/region.bin.br"},
        "cells": {
            "path": "series/cells",
            "cell_degrees": _CELL_DEGREES,
            "cells_per_tile": _CELLS_PER_TILE,
            "columns": cell_spec,
            "shard_fields": ["name", "rows", "bytes"],
            "shards": cell_shards,
            "bytes": cell_bytes,
        },
    }


def export_all(scope_name: str | None = None, out: Path | None = None) -> None:
    scope = config.SCOPES[scope_name or config.DEFAULT_SCOPE]
    out = out or (config.WEB_DATA / scope.name)
    out.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect(str(config.DUCKDB_PATH), read_only=True)
    try:
        # Everything downstream reads `zone_events`, never `fct_zone_events`
        # directly, so the release-date cut is applied in exactly one place and
        # cannot drift between the display stream, the per-zone history and the
        # aggregate series. The warehouse keeps the full record; this is the
        # export deciding what the game's history is.
        con.execute(f"""
            create or replace temp view zone_events as
            select * from fct_zone_events
            where activity_date >= date '{config.RECORD_START}'
        """)

        zone_count = _create_scope(con, scope, out)
        log.info("scope %s: %s zones", scope.name, f"{zone_count:,}")

        active_count = con.execute(
            "select count(*) from scope s "
            "where s.zone_id in (select zone_id from zone_events)"
        ).fetchone()[0]

        _clear_shards(out)
        lookups = _export_lookups(con, out)
        zone_ids = _export_zone_ids(con, out)
        geometry = _export_geometry(con, out)

        display = _export_display(con, out)
        zone_history = _export_zone_history(con, out)
        series = _export_series(con, out)
        area_series = _export_area_series(con, out)

        span = con.execute(
            "select min(activity_date), max(activity_date) from zone_events e "
            "join scope s on s.zone_id = e.zone_id"
        ).fetchone()

        # Headline figures for the state the paint bundle draws, so the panel
        # can be right on the first frame instead of showing zeroes until the
        # checkpoint and event shards land.
        now = con.execute("""
            with latest as (
                select e.zone_id,
                       arg_max(e.legion_count, e.observed_at)   as legion,
                       arg_max(e.swarm_count, e.observed_at)    as swarm,
                       arg_max(e.faceless_count, e.observed_at) as faceless
                from zone_events e
                join scope s on s.zone_id = e.zone_id
                group by e.zone_id
            )
            select sum(legion), sum(swarm), sum(faceless),
                   count(*) filter (where legion + swarm + faceless > 0)
            from latest
        """).fetchone()

        meta = {
            "scope": {
                "name": scope.name,
                "label": scope.label,
                "center": [scope.lat, scope.lon] if scope.radius_km else None,
                "radius_km": scope.radius_km,
                "active_only": scope.active_only,
                "zone_count": zone_count,
                # Zones that have held a bot at some point. The rest are real
                # places on the map that have simply never been played, and the
                # viewer draws them so the world is whole rather than only
                # showing where the fighting was.
                "active_count": int(active_count),
            },
            "day_epoch": config.DAY_EPOCH.isoformat(),
            "date_range": [span[0].isoformat(), span[1].isoformat()],
            "factions": {"0": "uncaptured", "1": "legion", "2": "swarm", "3": "faceless"},
            "current": {
                "date": span[1].isoformat(),
                "legion": int(now[0] or 0),
                "swarm": int(now[1] or 0),
                "faceless": int(now[2] or 0),
                "held": int(now[3] or 0),
            },
            "geometry": {k: v for k, v in geometry.items() if k != "_names"},
            "names": geometry["_names"],
            "zone_ids": zone_ids,
            "lookups": lookups,
            "display": display,
            "zone_history": zone_history,
            "series": series,
            "area_series": area_series,
            "encoding": {
                "container": "brotli",
                "note": (
                    "Every .br is a brotli stream over a columnar dump: each column is a "
                    "contiguous run of one fixed-width dtype, concatenated in the order "
                    "listed. Serve with Content-Encoding: br and the browser decompresses "
                    "it, so fetch(...).arrayBuffer() is already the raw bytes - take "
                    "typed-array views at the running offsets. A column marked 'delta' "
                    "holds successive differences; prefix-sum it to recover values, "
                    "respecting the dtype, because a signed delta column can go backwards."
                ),
                "event_order": "(zone idx, day) - build a day index on load, not file order",
            },
            "notes": [
                "Series are sparse: carry the previous value forward across gaps.",
                "2019 has an upstream collection gap and is not a real lull.",
                "Bot counts before 2012-05 are the backfill baseline, not observations.",
                "display/ is what the map draws at any date. zone_history/ is the exact "
                "record, fetched one block at a time and only for a zone in hand.",
            ],
        }
        (out / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

        scrub = (
            max(e["bytes"] for e in display["shards"])
            + max((e["bytes"] for e in display["anchors"]), default=0)
        )
        total = (
            display["anchor_bytes"]
            + display["shard_bytes"]
            + zone_history["bytes"]
            + geometry["first_paint_bytes"]
            + geometry["terrain_bytes"]
            + geometry["names_bytes"]
            + zone_ids["bytes"]
            + lookups["bytes"]
            + sum(s["bytes"] for s in series.values())
            + area_series["country"]["bytes"]
            + area_series["region"]["bytes"]
            + area_series["cells"]["bytes"]
        )
        log.info(
            "export complete: %s MB stored. What a reader actually fetches: %s MB for the "
            "played world, %s MB terrain, %s MB names, at most %s MB to land on any date. "
            "The %s MB of exact per-zone history is fetched a block at a time, on a hover.",
            f"{total / 1e6:.1f}",
            f"{geometry['first_paint_bytes'] / 1e6:.2f}",
            f"{geometry['terrain_bytes'] / 1e6:.2f}",
            f"{geometry['names_bytes'] / 1e6:.2f}",
            f"{scrub / 1e6:.2f}",
            f"{zone_history['bytes'] / 1e6:.1f}",
        )
    finally:
        con.close()
