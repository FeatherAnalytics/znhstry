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
import shutil
from pathlib import Path
from typing import Any

import brotli
import duckdb
import numpy as np
import polars as pl

from . import boundaries, config, distance

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
# than bytes: a cold load was 1,659 of them, each a round trip. 16 degrees takes
# the world from 474 populated tiles to about 150 and compresses slightly better
# on top. What it costs is precision in the nearest-first ordering: the first
# tile to land is four times the area, so "near the reader" is a coarser claim
# than it was.
TILE_DEGREES = 16

# Fixed-point coordinates, 1e-4 degrees ~ 11 m. A zone is about a kilometre
# across, so this is well inside the noise. 1e-3 (111 m) saves another 0.6 MB
# but visibly collapses neighbouring zones onto each other when zoomed in.
COORD_SCALE = 10_000


def _create_scope(con: duckdb.DuckDBPyConnection, scope: config.Scope, out: Path) -> int:
    """Materialise the zones in scope with a dense index.

    Haversine rather than the spatial extension: four lines of SQL against a
    bbox prefilter is faster to run and one less dependency to install. A scope
    with no radius covers the whole map.
    """
    filters = ["latitude is not null"]

    if scope.radius_km is not None:
        filters.append(distance.circle_sql(scope.lat, scope.lon, scope.radius_km))

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
        source = data[name]
        # DuckDB hands back a masked array for a column that carried nulls, and
        # `np.asarray` drops the mask rather than the row: the null keeps
        # whatever sat under it, which is a zero. A fixed-width dump has no
        # encoding for "unknown", so a null country would ship as country 0 and
        # a null count as an empty zone - both of which read as ordinary data
        # everywhere downstream. It has to be resolved in the query instead.
        if np.ma.is_masked(source):
            nulls = int(np.ma.getmaskarray(source).sum())
            raise ValueError(
                f"{name} carries {nulls:,} null(s) and would pack them as 0. "
                f"Decide what a null means in the query - coalesce it or drop the row."
            )
        column = np.asarray(source)
        if rows and dtype.startswith(("int", "uint")):
            # Silent wraparound is the failure mode these dumps are most
            # exposed to: a value one step past the width lands as a
            # plausible-looking small number rather than an error. A negative
            # day, say, would come from an event before DAY_EPOCH - the 2010
            # backfill rows - and underflow uint16 into a real-looking date.
            #
            # Every integer column, not a chosen few: which ones "can" overflow
            # is a judgement that goes stale the moment upstream widens a field,
            # and `area_id` is a uint16 fed straight from a country id.
            info = np.iinfo(dtype)
            low, high = int(column.min()), int(column.max())
            if high > info.max:
                raise OverflowError(f"{name} max {high:,} does not fit {dtype}")
            if low < info.min:
                hint = " (an event before DAY_EPOCH)" if dtype == DAY else ""
                raise ValueError(f"{name} min {low:,} does not fit {dtype}{hint}")

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
        "paint",
        "names",
        "atlantis",
    ):
        shutil.rmtree(out / name, ignore_errors=True)
    # Layouts this replaced. Left behind, they are dead weight that an upload
    # sync would keep serving to anyone holding a stale manifest.
    for stale_tree in ("geometry", "checkpoints", "events", "terrain"):
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
                "regions[region_id][1] is the region's own country. It disagrees with "
                "the zone's country_id for 447 zones, and the game files those under "
                "the region regardless -- its site counts regions by region_id and "
                "countries by country_id, so a region is not a subset of its country. "
                "Group the same way or your totals will not match a player's screen."
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


def _export_maz(con: duckdb.DuckDBPyConnection, out: Path) -> dict[str, Any]:
    """Most Active Zones, as (idx, day) and nothing else.

    A MAZ is not "a battle happened here". QONQR publishes a fixed number of
    reports a day from its Most Active Zones page, so a row means *this zone was
    among the most active in the world that day* - which is why the viewer draws
    it as a ring rather than folding it into the dots.

    **Keyed by idx, not zone_id.** The viewer already holds every zone's position
    at its idx, so shipping coordinates again would be a second copy that can
    disagree with the first, and shipping zone_id would make the client scan all
    2,682,442 entries of `zone_ids` to translate. Neither is necessary.

    Nothing else travels. The battle reports carry launches, players, bots
    killed and 70-odd other columns, and the map uses none of them: a ring's
    brightness and size are both appearances in a trailing window. Names come
    from `names/` on hover like any other zone.

    Sorted `(day, idx)` because every read is a contiguous range of days - the
    client bisects to a window and walks it. That ordering is also why `idx` is
    not delta-encoded: it restarts on every day boundary, so the differences
    would be negative and `_pack` only accepts ascending runs for an unsigned
    column.

    Tournament reports are excluded upstream by `fct_zone_battles`, which is a
    geographic model; their zones have negative ids and no coordinates.
    """
    entry = _write_columnar(
        out / "maz.bin.br",
        f"""
        select s.idx,
               cast(date_diff('day', date '{config.DAY_EPOCH}', b.battle_date) as integer) as day
        from fct_zone_battles b
        join scope s on s.zone_id = b.zone_id
        where b.battle_date >= date '{config.RECORD_START}'
        group by 1, 2
        order by day, idx
        """,
        {"idx": IDX, "day": DAY},
        con,
        delta=frozenset({"day"}),
    )
    span = con.execute(f"""
        select min(cast(date_diff('day', date '{config.DAY_EPOCH}', b.battle_date) as integer)),
               max(cast(date_diff('day', date '{config.DAY_EPOCH}', b.battle_date) as integer))
        from fct_zone_battles b
        join scope s on s.zone_id = b.zone_id
        where b.battle_date >= date '{config.RECORD_START}'
    """).fetchone()
    entry["day_min"] = int(span[0])
    entry["day_max"] = int(span[1])
    entry["stats"] = _export_maz_stats(con, out)
    log.info("maz: %s reports, %s KB", f"{entry['rows']:,}", entry["bytes"] // 1024)
    return entry


def _export_flashpoints(con: duckdb.DuckDBPyConnection, out: Path) -> dict[str, Any]:
    """The curated flashpoints, and what each one did to the bots around it.

    **The definitions travel in `meta.json` and the series in one shard.** Ten
    flashpoints are four kilobytes of JSON against a manifest already at 124 KB, and
    the manifest is fetched by every visit anyway - so folding them in costs 3% of a
    file already paid for and saves a request that would only ever follow it. The
    series are ~10 KB for all of them together, which is not worth ten objects and
    ten possible requests: requests are round trips, the same reason the tile grid is
    16 degrees.

    One shard also means there is no tree to clear. It is overwritten in place every
    run and cannot strand an orphan the way a per-flashpoint layout could.

    **`flashpoint` is a position, not an id.** The column is a uint8 index into the
    manifest's `entries` list, so the client filters rows without carrying ten
    strings per row. Both are ordered by `run_start`, and the two orders have to
    agree - which is why they are built from one query rather than two.

    **`changelog_covered` decides whether the viewer draws anything at all.** Six of
    the ten flashpoints predate usable coverage: the record before late 2018 is a
    thin stream of first sightings and 2019 is the collection gap, so the battle
    reports say the fight happened while the event stream has no rows for it. A
    chart over that is a flat line at zero, which reads as a calm neighborhood and is
    the opposite of the truth.
    """
    cursor = con.execute("""
        select f.flashpoint_id, f.label, f.blurb,
               f.anchor_latitude, f.anchor_longitude,
               f.board_start, f.board_end, f.run_start, f.run_end,
               f.radius_km, f.zones_in_circle, f.changelog_covered
        from fct_flashpoint f
        order by f.run_start, f.flashpoint_id
    """)
    names = [column[0] for column in cursor.description]
    manifest = [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]

    if not manifest:
        # Reachable without a seed, or when every anchor fails to resolve - which
        # `assert_flashpoint_anchors_all_resolve` exists to make legible, but a
        # `dbt run` without a `dbt test` gets here first. Stopping with a line in the
        # log beats an empty `values ()` and an opaque parser error mid-export.
        log.info("  flashpoints: none seeded")
        return {"path": None, "rows": 0, "columns": [], "bytes": 0, "entries": []}

    epoch = f"date '{config.DAY_EPOCH}'"
    order = {row["flashpoint_id"]: position for position, row in enumerate(manifest)}
    codes = ", ".join(f"('{fid}', {position})" for fid, position in order.items())

    entry = _write_columnar(
        out / "flashpoints.bin.br",
        f"""
        with code(flashpoint_id, flashpoint) as (values {codes})
        select c.flashpoint,
               cast(date_diff('day', {epoch}, i.activity_date) as integer) as day,
               cast(i.on_the_board as integer) as on_the_board,
               i.net_delta,
               i.zones_moving
        from fct_flashpoint_impact i
        join code c on c.flashpoint_id = i.flashpoint_id
        order by c.flashpoint, on_the_board, day
        """,
        {
            "flashpoint": "uint8",
            "day": DAY,
            "on_the_board": "uint8",
            "net_delta": COUNT,
            "zones_moving": "uint16",
        },
        con,
    )

    # Board membership is resolved to idx here rather than shipped as zone_id: the
    # viewer holds every zone's position at its idx already, and translating a
    # zone_id would mean scanning all 2,682,442 entries of `zone_ids`.
    board = con.execute("""
        select z.flashpoint_id, s.idx
        from fct_flashpoint_zone z
        join scope s on s.zone_id = z.zone_id
        where z.on_the_board
        order by 1, 2
    """).fetchall()
    board_idx: dict[str, list[int]] = {fid: [] for fid in order}
    for flashpoint_id, idx in board:
        board_idx[flashpoint_id].append(int(idx))

    def day_of(value: Any) -> int:
        return (value - config.DAY_EPOCH).days

    entry["entries"] = [
        {
            "id": row["flashpoint_id"],
            "label": row["label"],
            "blurb": row["blurb"],
            "lat": float(row["anchor_latitude"]),
            "lon": float(row["anchor_longitude"]),
            "board": [day_of(row["board_start"]), day_of(row["board_end"])],
            "run": [day_of(row["run_start"]), day_of(row["run_end"])],
            "radius_km": float(row["radius_km"]),
            "board_idx": board_idx[row["flashpoint_id"]],
            "zones_in_circle": int(row["zones_in_circle"]),
            "changelog_covered": bool(row["changelog_covered"]),
        }
        for row in manifest
    ]
    covered = sum(1 for row in manifest if row["changelog_covered"])
    log.info(
        "  flashpoints: %d (%d with changelog coverage), %s rows, %s KB",
        len(manifest),
        covered,
        f"{entry['rows']:,}",
        entry["bytes"] // 1024,
    )
    return entry


def _export_maz_stats(con: duckdb.DuckDBPyConnection, out: Path) -> dict[str, Any]:
    """What each MAZ report measured, **row-aligned with `maz.bin.br`**.

    No key columns at all: row *i* here describes row *i* there, and `idx` joins
    on to the geometry, names and history the viewer already has. Repeating the
    zone and the day would be two more columns saying what the other file
    already says, and two more chances for the two to disagree.

    The map never fetches this. Ring brightness and size are both appearances in
    a window, so nothing on screen depends on a launch count; this exists so the
    numbers are collected automatically and are there when something wants to
    read them. A per-*player* breakdown is a different job - the report pages
    carry a packed string of roughly 924,728 player rows that ingest does not
    unpack yet.

    `report` is QONQR's own battle report number, and it is here for one reason:
    it is the only thing that can point at the page a row came from,
    `portal.qonqr.com/Home/BattleStatistics/<report>`. Everything else in this
    payload is a measurement, so it is the one column that is a *reference*
    rather than a fact, and it cannot be derived from anything the client holds.
    Not delta-encoded: reports are numbered in the order QONQR wrote them and
    these rows are ordered `(day, idx)`, so the sequence climbs across days and
    scrambles within one.

    The three faction launch columns are a genuine split of `launches` and not
    the per-weapon breakdown. Read `stg_battlestats` before using them - the sum
    is short of the total for a ten-week window in 2019, which is collection
    rather than play, and a share taken across it will read as a faction going
    quiet.

    The same `group by` and `order by` as `_export_maz`, which is what keeps the
    rows aligned. Change one and you must change both.
    """
    entry = _write_columnar(
        out / "maz_stats.bin.br",
        f"""
        select max(b.battle_report_number)   as report,
               max(b.total_active_players)   as players,
               max(b.total_launches)         as launches,
               max(b.legion_total_launches)  as legion_launches,
               max(b.swarm_total_launches)   as swarm_launches,
               max(b.faceless_total_launches) as faceless_launches,
               max(b.bots_launched)          as bots_launched,
               max(b.bots_killed)            as bots_killed,
               max(b.bots_lost)              as bots_lost
        from fct_zone_battles b
        join scope s on s.zone_id = b.zone_id
        where b.battle_date >= date '{config.RECORD_START}'
        group by s.idx, b.battle_date
        order by cast(date_diff('day', date '{config.DAY_EPOCH}', b.battle_date) as integer),
                 s.idx
        """,
        {
            "report": IDX,
            "players": "uint16",
            "launches": COUNT,
            "legion_launches": COUNT,
            "swarm_launches": COUNT,
            "faceless_launches": COUNT,
            "bots_launched": COUNT,
            "bots_killed": COUNT,
            "bots_lost": COUNT,
        },
        con,
        quality=BROTLI_QUALITY_BULK,
    )
    log.info("maz stats: %s KB", entry["bytes"] // 1024)
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
        # Whether the zone has ever held a bot. A column rather than which file
        # the row arrived in - see the note on the tile loop below. All 0s and 1s,
        # so it costs almost nothing once brotli has seen it.
        "ever_active": "uint8",
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
                "ever_active": played[member].astype("uint8"),
            },
            position_columns,
            delta,
        )
        return payload, spec

    for key, start, end in zip(unique, starts, ends, strict=True):
        member = order[start:end]
        row, col = int(key // 1000), int(key % 1000)
        name = f"{row:02d}_{col:02d}"

        # Every zone in the tile, in one file, in the tile's spatial order.
        #
        # These used to be split by whether the zone had ever been played, so the
        # played world could paint before the grey arrived. It bought about a
        # second and cost three things worth more than that:
        #
        #   * ~24,000 zones a year are played for the first time, and each one
        #     moved between the two files. Both changed, both are served
        #     `immutable`, and a reader holding one and not the other sees a tile
        #     whose row count disagrees with the manifest.
        #   * Terrain loaded second, so every grey dot drew on top of every
        #     coloured one. Merged and sorted by position, they interleave.
        #   * Two files per tile to keep row-aligned with one paint file.
        #
        # A first play is now a change to one byte of `paint/`, which revalidates
        # normally, and the positions only change when a zone genuinely appears.
        payload, position_spec = pack_positions(member)
        tile_bytes = _write(out / "tiles" / f"{name}.bin.br", payload)
        paint_payload, paint_spec, _ = _pack({"pk": display_pk[member]}, paint_columns)
        paint_bytes = _write(out / "paint" / f"{name}.bin.br", paint_payload)

        tiles.append(
            [
                name,
                len(member),
                int(played[member].sum()),
                tile_bytes,
                paint_bytes,
                # South-west corner in degrees. The client derives the rest from
                # tile_degrees rather than carrying four floats per tile.
                row * TILE_DEGREES - 90,
                col * TILE_DEGREES - 180,
            ]
        )

    first_paint = sum(t[3] + t[4] for t in tiles)
    names_manifest = _export_names(idx, names, out)
    names_total = names_manifest["bytes"]
    log.info(
        "geometry: %d tiles - %s zones in %s MB (positions + paint), names %s MB",
        len(tiles),
        f"{sum(t[1] for t in tiles):,}",
        f"{first_paint / 1e6:.2f}",
        f"{names_total / 1e6:.2f}",
    )
    return {
        "tile_degrees": TILE_DEGREES,
        "coord_scale": COORD_SCALE,
        "magnitude_steps": _MAGNITUDE_STEPS,
        "paths": {"tiles": "tiles", "paint": "paint"},
        "position_columns": position_spec,
        "paint_columns": paint_spec,
        "tile_fields": [
            "name",
            # Every zone in the tile. `played` is how many of them have ever held
            # a bot, which is a fact for the reader rather than a row count - the
            # per-zone flag rides in the `ever_active` column.
            "zones",
            "played",
            "tile_bytes",
            "paint_bytes",
            "south",
            "west",
        ],
        "tiles": tiles,
        "first_paint_bytes": first_paint,
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

    **One pass over the event stream, cut up in Python.** A query per block was
    656 scans of all 9.88M rows to write 37 MB, because the block filter is a
    range over `idx` and nothing in the warehouse is indexed by it. Sorting by
    `(block, idx, observed_at)` is the same order block by block - `block` is
    `idx // 4096`, so it is a function of the key already being sorted on - and
    each block's rows land as one contiguous run. `idx` still delta-encodes from
    zero inside each file, because `_pack` runs per block on its own slice.
    """
    rows = con.execute(f"""
        select cast(s.idx // {_HISTORY_BLOCK} as integer) as block,
               s.idx,
               cast(date_diff('day', date '{config.DAY_EPOCH}', e.activity_date) as integer)
                   as day,
               e.control_state, e.legion_count, e.swarm_count, e.faceless_count
        from zone_events e
        join scope s on s.zone_id = e.zone_id
        order by block, s.idx, e.observed_at
    """).fetchnumpy()

    columns = {
        "idx": IDX,
        "day": DAY,
        "control_state": FACTION,
        "legion_count": COUNT,
        "swarm_count": COUNT,
        "faceless_count": COUNT,
    }

    blocks, starts = np.unique(rows["block"], return_index=True)
    ends = np.append(starts[1:], len(rows["block"]))

    entries: list[dict[str, Any]] = []
    for block, start, end in zip(blocks, starts, ends, strict=True):
        payload, spec, count = _pack(
            {name: rows[name][start:end] for name in columns},
            columns,
            frozenset({"idx"}),
        )
        path = out / "zone_history" / f"{int(block):04d}.bin.br"
        entries.append(
            {
                "path": path.name,
                "rows": count,
                "columns": spec,
                "bytes": _write(path, payload, BROTLI_QUALITY_BULK),
                "block": int(block),
            }
        )

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
    day = f"cast(date_diff('day', date '{config.DAY_EPOCH}', activity_date) as integer)"

    # The one query that reads a mart directly rather than through `zone_events`,
    # because the running totals are the mart's own and recomputing them here
    # would be a second definition of the same number.
    #
    # So the release-date cut is applied to the rows that go out, not to the
    # stream they are summed over. `fct_global_daily`'s spine starts at the 2010
    # backfill, and the 29 sentinel rows plus the 11 pre-release events carry
    # real bots: they are this record's opening balance, and dropping them from
    # the sum would restart the world at zero on 2012-07-30. `legion_bots` is
    # already a running total, so filtering the output alone keeps the first
    # emitted point carrying everything that came before it.
    global_series = _sparse_series(
        con,
        f"""
        select {day}, legion_bots, swarm_bots, faceless_bots
        from fct_global_daily
        where activity_date >= date '{config.RECORD_START}'
          and (legion_delta != 0 or swarm_delta != 0 or faceless_delta != 0)
        order by activity_date
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
        "having sum(e.legion_delta) != 0 or sum(e.swarm_delta) != 0 or sum(e.faceless_delta) != 0"
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

    # Grouped on region_id alone, which is how the game reads it: QONQR's own site
    # reports 1,890 zones in West Pomeranian Voivodeship and 198 in Northwest
    # Territories, both of which are the region_id counts. Country totals there come
    # from country_id - Poland is 44,080 either way - so the two fields are read
    # independently and a region is not a subset of its country.
    #
    # 447 zones make that visible, 155 of them filed under a Polish voivodeship while
    # sitting in the Solomon Islands. Charting them under Poland is what the game does,
    # and a series a player cannot reconcile against their own screen is worth less
    # than one that reaches across an ocean.
    region = _write_columnar(
        out / "series" / "region.bin.br",
        f"""
        select e.region_id as area_id, {day} as day,
               sum(e.legion_delta) as legion, sum(e.swarm_delta) as swarm,
               sum(e.faceless_delta) as faceless
        from zone_events e
        join scope s on s.zone_id = e.zone_id
        join stg_regions r on r.region_id = e.region_id
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
        cell_shards.append(
            [
                name,
                rows,
                _write(out / "series" / "cells" / f"{name}.bin.br", payload, BROTLI_QUALITY_BULK),
            ]
        )

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


_ZONE_PYRAMID_ORDER = [
    "Prime",
    "Legion 1", "Legion 2", "Legion 3", "Legion 4", "Legion 5", "Legion 6",
    "Swarm 1", "Swarm 2", "Swarm 3", "Swarm 4", "Swarm 5", "Swarm 6",
    "Faceless 1", "Faceless 2", "Faceless 3", "Faceless 4", "Faceless 5", "Faceless 6",
]

_FACTION_ORDER = ("Legion", "Swarm", "Faceless")

_TRIANGLE_ORDER = {"Central": 0, "Legion": 1, "Swarm": 2, "Faceless": 3}
_DERIVED_PLAYER_ORDER = ("Legion", "Swarm", "Faceless", "Unconfirmed")


def _export_atlantis(con: duckdb.DuckDBPyConnection, out: Path) -> dict[str, Any]:
    tree = out / "atlantis"
    tree.mkdir(parents=True, exist_ok=True)

    result = con.execute(
        "select * from dim_atlantis_tournament order by tournament_month"
    )
    tournament_cols = [d[0] for d in result.description]
    tournaments = result.fetchall()
    months_written: list[str] = []
    total_bytes = 0

    for row in tournaments:
        t = dict(zip(tournament_cols, row, strict=True))
        month_str = t["tournament_month"].strftime("%Y-%m")
        payload = _build_month_payload(con, t, month_str)
        path = tree / f"{month_str}.json.br"
        total_bytes += _write_json(path, payload)
        months_written.append(f"atlantis/{month_str}.json.br")

    derived_result = con.execute(
        "select * from dim_atlantis_tournament_derived where not has_board "
        "order by tournament_month"
    )
    derived_cols = [d[0] for d in derived_result.description]
    derived_tournaments = derived_result.fetchall()

    for row in derived_tournaments:
        dt = dict(zip(derived_cols, row, strict=True))
        month_str = dt["tournament_month"].strftime("%Y-%m")
        payload = _build_derived_month_payload(con, dt, month_str)
        path = tree / f"{month_str}.json.br"
        total_bytes += _write_json(path, payload)
        months_written.append(f"atlantis/{month_str}.json.br")

    players_payload = _build_players_payload(con)
    total_bytes += _write_json(tree / "players.json.br", players_payload)

    index = _build_atlantis_index(
        con, tournaments, tournament_cols,
        derived_tournaments, derived_cols,
    )
    total_bytes += _write_json(tree / "index.json.br", index)

    total_tournaments = len(tournaments) + len(derived_tournaments)
    log.info(
        "atlantis: %s tournaments (%s board, %s derived), %s players, %s KB",
        total_tournaments,
        len(tournaments),
        len(derived_tournaments),
        len(players_payload),
        total_bytes // 1024,
    )
    return {
        "path": "atlantis/",
        "index": "atlantis/index.json.br",
        "players": "atlantis/players.json.br",
        "months": sorted(months_written),
        "bytes": total_bytes,
    }


def _build_month_payload(
    con: duckdb.DuckDBPyConnection, t: dict, month_str: str,
) -> dict:
    month = t["tournament_month"]

    observations = [
        ts.isoformat() + "Z"
        for (ts,) in con.execute(
            """
            select distinct observed_at from (
                select observed_at from stg_atlantis_leaderboard
                where tournament_month = $1
                union
                select observed_at from stg_atlantis_zones
                where tournament_month = $1
            ) order by 1
            """,
            [month],
        ).fetchall()
    ]
    obs_index = {ts: i for i, ts in enumerate(observations)}

    players = _build_players_dict(con, month, obs_index, len(observations))
    factions = _build_factions_dict(con, month, obs_index, len(observations))
    zones = _build_zones_dict(con, month, obs_index, len(observations))

    placements = []
    for rank_col, zone_col, pool_col in (
        ("first_place", "first_zones", "first_pool"),
        ("second_place", "second_zones", "second_pool"),
        ("third_place", "third_zones", "third_pool"),
    ):
        if t[rank_col]:
            placements.append([t[rank_col], int(t[zone_col]), int(t[pool_col])])

    battles = _build_battles_dict(con, month)

    return {
        "month": month_str,
        "observations": observations,
        "placements": placements,
        "is_finished": t["is_finished"],
        "source": t.get("source", "portal"),
        "players": players,
        "factions": factions,
        "zones": zones,
        "battles": battles,
    }


def _build_derived_month_payload(
    con: duckdb.DuckDBPyConnection, dt: dict, month_str: str,
) -> dict:
    month = dt["tournament_month"]

    pools = con.execute(
        "select first_pool, second_pool, third_pool from atlantis_pools "
        "where effective_from = (select max(effective_from) from atlantis_pools "
        "where effective_from <= $1)",
        [month],
    ).fetchone()

    placements = []
    for rank_col, zone_col in (
        ("first_place", "first_zones"),
        ("second_place", "second_zones"),
        ("third_place", "third_zones"),
    ):
        faction = dt[rank_col]
        pool = pools[len(placements)] if pools else 0
        if faction:
            placements.append([faction, int(dt[zone_col]), int(pool)])

    zones = _build_derived_zones(con, month)
    players = _build_derived_players(con, month)

    return {
        "month": month_str,
        "source": "reports",
        "placements": placements,
        "zones": zones,
        "players": players,
    }


def _build_derived_zones(
    con: duckdb.DuckDBPyConnection, month: Any,
) -> list[dict]:
    rows = con.execute(
        "select zone_name, triangle, position, "
        "legion_ending_bots, swarm_ending_bots, faceless_ending_bots, holder "
        "from fct_atlantis_zone_month_derived where tournament_month = $1",
        [month],
    ).fetchall()

    def sort_key(r: tuple) -> tuple:
        tri = _TRIANGLE_ORDER.get(r[1], 99)
        pos = r[2] if r[2] is not None else 99
        return (tri, pos, r[0])

    result = []
    for name, triangle, position, lg, sw, fc, holder in sorted(rows, key=sort_key):
        result.append({
            "name": name,
            "triangle": triangle,
            "position": int(position) if position is not None else None,
            "legion": int(lg),
            "swarm": int(sw),
            "faceless": int(fc),
            "holder": holder,
        })
    return result


def _build_derived_players(
    con: duckdb.DuckDBPyConnection, month: Any,
) -> dict:
    rows = con.execute(
        "select player_name, faction, faction_source, is_mercenary, "
        "launches, bots_killed, bots_lost, reports, qredits_estimate "
        "from fct_atlantis_player_month_derived where tournament_month = $1 "
        "order by faction, launches desc, player_name",
        [month],
    ).fetchall()

    result: dict[str, dict] = {}
    for name, faction, source, merc, launches, killed, lost, reps, qr in rows:
        if faction not in result:
            result[faction] = {}
        entry: dict[str, Any] = {
            "launches": int(launches),
            "bots_killed": int(killed),
            "bots_lost": int(lost),
            "reports": int(reps),
            "faction_source": source,
            "is_mercenary": bool(merc) if merc is not None else False,
        }
        entry["qredits_estimate"] = round(float(qr), 1) if qr is not None else None
        result[faction][name] = entry

    ordered: dict[str, dict] = {}
    for f in _DERIVED_PLAYER_ORDER:
        if f in result:
            ordered[f] = result[f]
    return ordered


def _build_battles_dict(
    con: duckdb.DuckDBPyConnection, month: Any,
) -> dict[str, dict[str, list]]:
    rows = con.execute(
        """
        select battle_date, coalesce(zone, zone_name) as zone_key,
               player_name, launches, bots_killed, bots_lost
        from fct_atlantis_zone_player_daily
        where tournament_month = $1
        order by battle_date, zone_key, rank, player_name
        """,
        [month],
    ).fetchall()

    result: dict[str, dict[str, list]] = {}
    for battle_date, zone_key, player_name, launches, killed, lost in rows:
        day = battle_date.isoformat()
        if day not in result:
            result[day] = {}
        if zone_key not in result[day]:
            result[day][zone_key] = []
        result[day][zone_key].append([player_name, int(launches), int(killed), int(lost)])

    for day in result:
        ordered: dict[str, list] = {}
        for zone in _ZONE_PYRAMID_ORDER:
            if zone in result[day]:
                ordered[zone] = result[day][zone]
        for zone in result[day]:
            if zone not in ordered:
                ordered[zone] = result[day][zone]
        result[day] = ordered

    return result


def _new_player_entry(n_obs: int) -> dict:
    return {"launches": [None] * n_obs, "tm": [None] * n_obs, "wm": [None] * n_obs}


def _coerce(val: Any, to_type: type) -> Any:
    return to_type(val) if val is not None else None


def _build_players_dict(
    con: duckdb.DuckDBPyConnection,
    month,
    obs_index: dict[str, int],
    n_obs: int,
) -> dict:
    rows = con.execute(
        """
        select l.faction, l.player_name, l.observed_at, l.launches,
               l.tournament_million_kills, l.weekly_million_kills,
               p.qredits
        from stg_atlantis_leaderboard l
        left join fct_atlantis_payout p
            on  p.tournament_month = l.tournament_month
            and p.faction          = l.faction
            and p.player_name      = l.player_name
        where l.tournament_month = $1
        order by l.faction, l.player_name, l.observed_at
        """,
        [month],
    ).fetchall()

    result: dict[str, dict] = {f: {} for f in _FACTION_ORDER}
    qredits_map: dict[tuple[str, str], float] = {}

    for faction, player, obs_at, launches, tm, wm, qr in rows:
        idx = obs_index.get(obs_at.isoformat() + "Z")
        if idx is None:
            continue
        entry = result.setdefault(faction, {}).setdefault(
            player, _new_player_entry(n_obs),
        )
        entry["launches"][idx] = _coerce(launches, int)
        entry["tm"][idx] = _coerce(tm, bool)
        entry["wm"][idx] = _coerce(wm, bool)
        if qr is not None:
            qredits_map[(faction, player)] = float(qr)

    for faction in _FACTION_ORDER:
        players = result.get(faction, {})
        for player, entry in players.items():
            qr = qredits_map.get((faction, player))
            if qr is not None:
                entry["qredits"] = round(qr, 1)
        result[faction] = dict(sorted(players.items()))

    return {f: result[f] for f in _FACTION_ORDER if result.get(f)}


def _build_factions_dict(
    con: duckdb.DuckDBPyConnection,
    month,
    obs_index: dict[str, int],
    n_obs: int,
) -> dict:
    rows = con.execute(
        """
        select faction, observed_at, launches_gained, active_players,
               players_on_board, launches_total
        from fct_atlantis_faction_hourly
        where tournament_month = $1
        order by faction, observed_at
        """,
        [month],
    ).fetchall()

    result: dict[str, dict] = {}
    for faction in _FACTION_ORDER:
        result[faction] = {
            "launches_gained": [None] * n_obs,
            "active_players": [None] * n_obs,
            "players_on_board": [None] * n_obs,
            "launches_total": [None] * n_obs,
        }

    for faction, obs_at, lg, ap, pob, lt in rows:
        key = obs_at.isoformat() + "Z"
        idx = obs_index.get(key)
        if idx is None or faction not in result:
            continue
        result[faction]["launches_gained"][idx] = int(lg)
        result[faction]["active_players"][idx] = int(ap)
        result[faction]["players_on_board"][idx] = int(pob)
        result[faction]["launches_total"][idx] = int(lt)

    return {f: result[f] for f in _FACTION_ORDER if result.get(f)}


def _build_zones_dict(
    con: duckdb.DuckDBPyConnection,
    month,
    obs_index: dict[str, int],
    n_obs: int,
) -> dict:
    zone_meta = {
        zone: (name, bool(ca))
        for zone, name, ca in con.execute(
            "select zone, zone_name, cubes_allowed from stg_atlantis_zone_months "
            "where tournament_month = $1",
            [month],
        ).fetchall()
    }

    rows = con.execute(
        """
        select zone, observed_at, swarm_count, legion_count, faceless_count
        from stg_atlantis_zones
        where tournament_month = $1
        order by zone, observed_at
        """,
        [month],
    ).fetchall()

    data: dict[str, dict] = {}
    for zone, obs_at, sw, lg, fc in rows:
        key = obs_at.isoformat() + "Z"
        idx = obs_index.get(key)
        if idx is None:
            continue
        if zone not in data:
            meta = zone_meta.get(zone, (zone, False))
            data[zone] = {
                "name": meta[0],
                "cubes_allowed": meta[1],
                "swarm": [None] * n_obs,
                "legion": [None] * n_obs,
                "faceless": [None] * n_obs,
            }
        data[zone]["swarm"][idx] = int(sw)
        data[zone]["legion"][idx] = int(lg)
        data[zone]["faceless"][idx] = int(fc)

    result = {}
    for zone in _ZONE_PYRAMID_ORDER:
        if zone in data:
            result[zone] = data[zone]
    return result


def _build_players_payload(con: duckdb.DuckDBPyConnection) -> dict:
    """Per-player month rows from both collected and derived marts."""
    rows = con.execute("""
        with by_faction as (
            select tournament_month, player_name, faction,
                   sum(bots_killed) as bots_killed,
                   sum(bots_lost) as bots_lost
            from fct_atlantis_player_month_derived
            group by 1, 2, 3
        ),
        by_player as (
            select tournament_month, player_name,
                   sum(bots_killed) as bots_killed,
                   sum(bots_lost) as bots_lost,
                   bool_and(faction = 'Unconfirmed') as all_unconfirmed
            from fct_atlantis_player_month_derived
            group by 1, 2
        ),
        board as (
            select p.player_name, t.tournament_month, p.faction,
                   p.launches,
                   coalesce(
                       bf.bots_killed,
                       case when bp.all_unconfirmed then bp.bots_killed end,
                       0
                   ) as bots_killed,
                   coalesce(
                       bf.bots_lost,
                       case when bp.all_unconfirmed then bp.bots_lost end,
                       0
                   ) as bots_lost,
                   cast(null as smallint) as rank_in_faction,
                   p.qredits, 'board' as source
            from fct_atlantis_payout p
            join dim_atlantis_tournament t on t.tournament_month = p.tournament_month
            left join by_faction bf
                on bf.tournament_month = p.tournament_month
                and bf.player_name = p.player_name
                and bf.faction = p.faction
            left join by_player bp
                on bp.tournament_month = p.tournament_month
                and bp.player_name = p.player_name
            where t.is_finished and not p.is_estimate
        ),
        finished_board as (
            select tournament_month from dim_atlantis_tournament where is_finished
        ),
        derived as (
            select p.player_name, p.tournament_month, p.faction,
                   p.launches, p.bots_killed, p.bots_lost,
                   p.rank_in_faction,
                   p.qredits_estimate as qredits,
                   'derived' as source
            from fct_atlantis_player_month_derived p
            where p.tournament_month not in (select * from finished_board)
        )
        select * from board union all select * from derived
        order by player_name, tournament_month, faction
    """).fetchall()

    result: dict[str, list] = {}
    for name, month, faction, launches, killed, lost, rank, qr, src in rows:
        if name not in result:
            result[name] = []
        result[name].append([
            month.strftime("%Y-%m"), faction, int(launches),
            int(killed), int(lost),
            int(rank) if rank is not None else None,
            round(float(qr), 1) if qr is not None else None,
            src,
        ])
    return result


def _faction_launches_kills(con: duckdb.DuckDBPyConnection) -> dict:
    """Per-faction launches and kills for every tournament month."""
    launches = _faction_launches(con)
    kills = _faction_kills(con)
    _ORDER = ("Legion", "Swarm", "Faceless")
    months = set(launches) | set(kills)
    result: dict[str, dict] = {}
    for m in months:
        lm = launches.get(m, {})
        km = kills.get(m, {})
        result[m] = {
            "launches": {f: lm.get(f, 0) for f in _ORDER if f in lm},
            "kills": {f: km.get(f, 0) for f in _ORDER if f in km},
        }
    return result


def _faction_launches(con: duckdb.DuckDBPyConnection) -> dict[str, dict[str, int]]:
    rows = con.execute("""
        with finished_board as (
            select tournament_month from dim_atlantis_tournament where is_finished
        ),
        board_launches as (
            select p.tournament_month, p.faction, sum(p.launches) as launches
            from fct_atlantis_payout p
            where p.tournament_month in (select * from finished_board)
                and not p.is_estimate and p.faction != 'Unconfirmed'
            group by 1, 2
        ),
        header_launches as (
            select tournament_month, 'Legion' as faction, legion_launches as launches
            from dim_atlantis_tournament_derived
            where tournament_month not in (select * from finished_board)
            union all
            select tournament_month, 'Swarm', swarm_launches
            from dim_atlantis_tournament_derived
            where tournament_month not in (select * from finished_board)
            union all
            select tournament_month, 'Faceless', faceless_launches
            from dim_atlantis_tournament_derived
            where tournament_month not in (select * from finished_board)
        )
        select * from board_launches union all select * from header_launches
        order by 1, 2
    """).fetchall()
    result: dict[str, dict[str, int]] = {}
    for month, faction, launches in rows:
        key = month.strftime("%Y-%m")
        result.setdefault(key, {})[faction] = int(launches)
    return result


def _faction_kills(con: duckdb.DuckDBPyConnection) -> dict[str, dict[str, int]]:
    rows = con.execute("""
        with finished_board as (
            select tournament_month from dim_atlantis_tournament where is_finished
        ),
        by_faction as (
            select tournament_month, player_name, faction,
                   sum(bots_killed) as kills
            from fct_atlantis_player_month_derived
            where faction != 'Unconfirmed'
            group by 1, 2, 3
        ),
        by_player as (
            select tournament_month, player_name,
                   sum(bots_killed) as kills,
                   bool_and(faction = 'Unconfirmed') as all_unconfirmed
            from fct_atlantis_player_month_derived
            group by 1, 2
        ),
        board_kills as (
            select p.tournament_month, p.faction,
                   sum(coalesce(
                       bf.kills,
                       case when bp.all_unconfirmed then bp.kills end,
                       0
                   )) as kills
            from fct_atlantis_payout p
            left join by_faction bf
                on bf.tournament_month = p.tournament_month
                and bf.player_name = p.player_name
                and bf.faction = p.faction
            left join by_player bp
                on bp.tournament_month = p.tournament_month
                and bp.player_name = p.player_name
            where p.tournament_month in (select * from finished_board)
                and not p.is_estimate and p.faction != 'Unconfirmed'
            group by 1, 2
        ),
        derived_kills as (
            select tournament_month, faction, sum(bots_killed) as kills
            from fct_atlantis_player_month_derived
            where tournament_month not in (select * from finished_board)
                and faction != 'Unconfirmed'
            group by 1, 2
        )
        select * from board_kills union all select * from derived_kills
        order by 1, 2
    """).fetchall()
    result: dict[str, dict[str, int]] = {}
    for month, faction, kills in rows:
        key = month.strftime("%Y-%m")
        result.setdefault(key, {})[faction] = int(kills)
    return result


def _build_atlantis_index(
    con: duckdb.DuckDBPyConnection,
    tournaments: list[tuple],
    cols: list[str],
    derived_tournaments: list[tuple],
    derived_cols: list[str],
) -> dict:
    tournament_list = []
    for row in tournaments:
        t = dict(zip(cols, row, strict=True))
        placements = []
        for rank_col, zone_col, pool_col in (
            ("first_place", "first_zones", "first_pool"),
            ("second_place", "second_zones", "second_pool"),
            ("third_place", "third_zones", "third_pool"),
        ):
            if t[rank_col]:
                placements.append([t[rank_col], int(t[zone_col]), int(t[pool_col])])

        top = {}
        for faction, player_col, launches_col in (
            ("Swarm", "swarm_top_player", "swarm_top_launches"),
            ("Legion", "legion_top_player", "legion_top_launches"),
            ("Faceless", "faceless_top_player", "faceless_top_launches"),
        ):
            if t[player_col]:
                top[faction] = [t[player_col], int(t[launches_col])]

        tournament_list.append({
            "month": t["tournament_month"].strftime("%Y-%m"),
            "stacking_days": int(t["stacking_days"]),
            "battle_days": int(t["battle_days"]),
            "starts_at": t["starts_at"].isoformat() + "Z",
            "ends_at": t["ends_at"].isoformat() + "Z",
            "winner": t["winner"],
            "is_finished": t["is_finished"],
            "source": t.get("source", "portal"),
            "observations": int(t["observations"]),
            "players": int(t["players"]),
            "launches_total": int(t["launches_total"]),
            "first_observed_at": t["first_observed_at"].isoformat() + "Z",
            "last_observed_at": t["last_observed_at"].isoformat() + "Z",
            "placements": placements,
            "top": top,
        })

    derived_list = _build_derived_tournament_list(con, derived_tournaments, derived_cols)

    flk = _faction_launches_kills(con)
    empty = {"launches": {}, "kills": {}}
    for entry in tournament_list:
        m = flk.get(entry["month"], empty)
        entry["launches"] = m["launches"]
        entry["kills"] = m["kills"]
    for entry in derived_list:
        m = flk.get(entry["month"], empty)
        entry["launches"] = m["launches"]
        entry["kills"] = m["kills"]

    all_time = _build_all_time_merged(con)

    return {
        "tournaments": tournament_list,
        "tournaments_derived": derived_list,
        "all_time": all_time,
    }


def _build_all_time_merged(con: duckdb.DuckDBPyConnection) -> dict:
    rows = con.execute("""
        with board as (
            select p.player_name, p.faction, p.tournament_month,
                   p.launches, p.qredits
            from fct_atlantis_payout p
            join dim_atlantis_tournament t on t.tournament_month = p.tournament_month
            where t.is_finished and not p.is_estimate
        ),
        finished_board as (
            select tournament_month from dim_atlantis_tournament where is_finished
        ),
        derived as (
            select p.player_name, p.faction, p.tournament_month,
                   p.launches, p.qredits_estimate as qredits
            from fct_atlantis_player_month_derived p
            where p.tournament_month not in (select * from finished_board)
        ),
        combined as (
            select * from board union all select * from derived
        )
        select player_name, faction,
               sum(launches) as launches,
               count(distinct tournament_month) as tournaments,
               min(tournament_month) as first_month,
               max(tournament_month) as last_month,
               sum(qredits) as qredits
        from combined
        group by 1, 2
        order by player_name, launches desc
    """).fetchall()

    merged: dict[str, dict] = {}
    for name, faction, launches, tournaments, first_m, last_m, qredits in rows:
        if name not in merged:
            merged[name] = {
                "name": name, "factions": {},
                "launches": 0, "tournaments": 0, "unattributed": 0,
                "first_month": first_m.strftime("%Y-%m"),
                "last_month": last_m.strftime("%Y-%m"),
                "qredits": 0.0,
            }
        entry = merged[name]
        entry["launches"] += int(launches)
        entry["tournaments"] += int(tournaments)
        if first_m.strftime("%Y-%m") < entry["first_month"]:
            entry["first_month"] = first_m.strftime("%Y-%m")
        if last_m.strftime("%Y-%m") > entry["last_month"]:
            entry["last_month"] = last_m.strftime("%Y-%m")
        if faction == "Unconfirmed":
            entry["unattributed"] += int(launches)
        else:
            prev = entry["factions"].get(faction, {"launches": 0, "tournaments": 0, "qredits": 0.0})
            entry["factions"][faction] = {
                "launches": prev["launches"] + int(launches),
                "tournaments": prev["tournaments"] + int(tournaments),
                "qredits": round(prev["qredits"] + float(qredits or 0), 1),
            }
            entry["qredits"] = round(entry["qredits"] + float(qredits or 0), 1)

    _FACTION_ORDER = ("Legion", "Swarm", "Faceless")
    for entry in merged.values():
        if not entry["factions"]:
            entry["qredits"] = None
        else:
            fmap = entry["factions"]
            entry["factions"] = {f: fmap[f] for f in _FACTION_ORDER if f in fmap}

    players = sorted(merged.values(), key=lambda p: (-p["launches"], p["name"]))

    factions = _build_all_time_factions(con)
    return {"players": players, "factions": factions}


def _derived_placements(dt: dict, pools: tuple | None) -> list:
    result = []
    for i, (rc, zc) in enumerate((
        ("first_place", "first_zones"),
        ("second_place", "second_zones"),
        ("third_place", "third_zones"),
    )):
        if dt[rc]:
            result.append([dt[rc], int(dt[zc]), int(pools[i]) if pools else 0])
    return result


def _derived_top_players(con: duckdb.DuckDBPyConnection, month: Any) -> dict:
    rows = con.execute(
        "select faction, player_name, launches "
        "from fct_atlantis_player_month_derived "
        "where tournament_month = $1 and faction != 'Unconfirmed' "
        "order by faction, launches desc",
        [month],
    ).fetchall()
    top: dict[str, list] = {}
    for faction, player, launches in rows:
        if faction not in top:
            top[faction] = [player, int(launches)]
    return top


def _build_derived_tournament_list(
    con: duckdb.DuckDBPyConnection,
    derived_tournaments: list[tuple],
    derived_cols: list[str],
) -> list[dict]:
    result = []
    for row in derived_tournaments:
        dt = dict(zip(derived_cols, row, strict=True))
        month = dt["tournament_month"]

        pools = con.execute(
            "select first_pool, second_pool, third_pool from atlantis_pools "
            "where effective_from = (select max(effective_from) from atlantis_pools "
            "where effective_from <= $1)",
            [month],
        ).fetchone()

        report_dates = con.execute(
            "select min(battle_date), max(battle_date) "
            "from fct_atlantis_zone_player_daily where tournament_month = $1",
            [month],
        ).fetchone()

        result.append({
            "month": month.strftime("%Y-%m"),
            "source": "reports",
            "has_board": False,
            "stacking_days": int(dt["stacking_days"]),
            "battle_days": int(dt["battle_days"]),
            "starts_at": dt["starts_at"].isoformat() + "Z",
            "ends_at": dt["ends_at"].isoformat() + "Z",
            "end_tolerance_days": (
                int(dt["end_tolerance_days"]) if dt["end_tolerance_days"] is not None else None
            ),
            "schedule_note": dt["schedule_note"],
            "placement_tiebreak": dt["placement_tiebreak"],
            "winner": dt["winner"],
            "zone_count": int(dt["zone_count"]),
            "reports": int(dt["reports"]),
            "players": int(dt["players"]),
            "launches_total": int(dt["launches_total"]),
            "first_report_date": (
                report_dates[0].isoformat() if report_dates and report_dates[0] else None
            ),
            "last_report_date": (
                report_dates[1].isoformat() if report_dates and report_dates[1] else None
            ),
            "placements": _derived_placements(dt, pools),
            "top": _derived_top_players(con, month),
        })
    return result


def _build_all_time_factions(con: duckdb.DuckDBPyConnection) -> dict:
    rows = con.execute("""
        with finished_board as (
            select tournament_month from dim_atlantis_tournament where is_finished
        ),
        board_wins as (
            select winner as faction, count(*) as wins
            from dim_atlantis_tournament where is_finished and winner is not null
            group by 1
        ),
        derived_wins as (
            select winner as faction, count(*) as wins
            from dim_atlantis_tournament_derived
            where tournament_month not in (select * from finished_board)
                and winner is not null
            group by 1
        ),
        board_qr as (
            select p.faction, round(sum(p.qredits), 0) as qredits,
                   sum(p.launches) as launches
            from fct_atlantis_payout p
            where p.tournament_month in (select * from finished_board)
                and not p.is_estimate
            group by 1
        ),
        derived_launches as (
            select 'Legion' as faction, sum(legion_launches) as launches
            from dim_atlantis_tournament_derived
            where tournament_month not in (select * from finished_board)
            union all
            select 'Swarm', sum(swarm_launches)
            from dim_atlantis_tournament_derived
            where tournament_month not in (select * from finished_board)
            union all
            select 'Faceless', sum(faceless_launches)
            from dim_atlantis_tournament_derived
            where tournament_month not in (select * from finished_board)
        ),
        derived_qr as (
            select p.faction,
                   round(sum(coalesce(p.qredits_estimate, 0)), 0) as qredits
            from fct_atlantis_player_month_derived p
            where p.tournament_month not in (select * from finished_board)
                and p.faction != 'Unconfirmed'
            group by 1
        )
        select f.faction,
               coalesce(bw.wins, 0) + coalesce(dw.wins, 0) as wins,
               coalesce(bq.qredits, 0) + coalesce(dq.qredits, 0) as qredits,
               coalesce(bq.launches, 0) + coalesce(dl.launches, 0) as launches
        from (values ('Legion'), ('Swarm'), ('Faceless')) f(faction)
        left join board_wins bw on bw.faction = f.faction
        left join derived_wins dw on dw.faction = f.faction
        left join board_qr bq on bq.faction = f.faction
        left join derived_launches dl on dl.faction = f.faction
        left join derived_qr dq on dq.faction = f.faction
        order by wins desc, qredits desc
    """).fetchall()
    return {
        f: {"wins": int(w), "qredits": int(qr), "launches": int(la)}
        for f, w, qr, la in rows
    }


def export_all(scope_name: str | None = None, out: Path | None = None) -> None:
    scope = config.SCOPES[scope_name or config.DEFAULT_SCOPE]
    out = out or (config.WEB_DATA / scope.name)
    out.mkdir(parents=True, exist_ok=True)

    # The outlines sit beside the scope directory rather than inside it - they are the
    # same world whichever slice is exported - and they are written here rather than
    # left to the `boundaries` step because `upload` deletes every object the data
    # directory does not contain. Anything a nightly run does not write is swept out of
    # the bucket, and the map loses its coastlines without saying so. The Natural Earth
    # source is cached under `data/raw`, so a re-run costs a brotli pass and no request.
    boundaries.export_boundaries(out.parent)

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
            "select count(*) from scope s where s.zone_id in (select zone_id from zone_events)"
        ).fetchone()[0]

        _clear_shards(out)
        lookups = _export_lookups(con, out)
        zone_ids = _export_zone_ids(con, out)
        geometry = _export_geometry(con, out)

        display = _export_display(con, out)
        zone_history = _export_zone_history(con, out)
        series = _export_series(con, out)
        area_series = _export_area_series(con, out)
        maz = _export_maz(con, out)
        flashpoints = _export_flashpoints(con, out)
        atlantis = _export_atlantis(con, out)

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
            "maz": maz,
            "flashpoints": flashpoints,
            "atlantis": atlantis,
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

        scrub = max(e["bytes"] for e in display["shards"]) + max(
            (e["bytes"] for e in display["anchors"]), default=0
        )
        total = (
            display["anchor_bytes"]
            + display["shard_bytes"]
            + zone_history["bytes"]
            + geometry["first_paint_bytes"]
            + geometry["names_bytes"]
            + zone_ids["bytes"]
            + lookups["bytes"]
            + sum(s["bytes"] for s in series.values())
            + area_series["country"]["bytes"]
            + area_series["region"]["bytes"]
            + area_series["cells"]["bytes"]
        )
        log.info(
            "export complete: %s MB stored. What a reader actually fetches: %s MB for every "
            "zone on the map, %s MB names, at most %s MB to land on any date. "
            "The %s MB of exact per-zone history is fetched a block at a time, on a hover.",
            f"{total / 1e6:.1f}",
            f"{geometry['first_paint_bytes'] / 1e6:.2f}",
            f"{geometry['names_bytes'] / 1e6:.2f}",
            f"{scrub / 1e6:.2f}",
            f"{zone_history['bytes'] / 1e6:.1f}",
        )
    finally:
        con.close()
