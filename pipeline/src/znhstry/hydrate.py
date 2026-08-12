"""Build a queryable warehouse out of the published export, with no credentials.

`data/raw` is not rebuildable from upstream - the Dropbox ring reaches back 31 days and
the record starts in 2012 - so the usual first step on a clone is `restore`, which needs
an R2 key. This step is the other way in: **the export is public**. It is exactly what
the browser downloads, and `zone_history/` in it is the complete event stream, all
9.9M rows of it, one row per event.

So anyone who clones the repo can have the history without being handed a secret.

What comes back, and what does not:

| | |
|---|---|
| every event, per zone, per day | `zone_history/` - idx, control state, three counts |
| coordinates, country, region, ever-played | `tiles/` |
| `ZoneId` behind each `idx` | `zone_ids.bin.br` |
| zone, country and region names | `names/`, `lookups.json.br` |
| the Most Active Zones record | `maz.bin.br` + `maz_stats.bin.br` |

Two things are genuinely absent. **The grain is a day, not a timestamp** - the export
stores `day` rather than `observed_at`, so the 653,071 zone-days carrying more than one
event arrive as several rows on the same date, in the right order but without the times
that separated them. And **battlestats is only what MAZ carries**: five measures a
report, not the 77 columns the scrape collects.

This is therefore a warehouse to read, not a substitute for `data/raw`. It cannot be
uploaded, it cannot be exported from, and `ingest` cannot extend it - `plan_slots` needs
the raw layer's own history. Nothing here writes to `data/raw` or to the dbt database.

`control_state` is preserved as the export stores it, and it is a trap worth restating:
it names whoever captured a zone last and goes on naming them long after their last bot
is gone. Ask the three count columns who holds a zone, never this one.
"""

from __future__ import annotations

import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import duckdb
import httpx
import numpy as np
import polars as pl

from . import config

log = logging.getLogger(__name__)

# A column spec as `meta.json` writes it: [name, dtype, encoding].
Spec = list[list[Any]]

RETRIES = 3

# Seconds before the second attempt, doubling after. `r2.dev` is rate-limited, and eight
# workers over ~1,480 objects is exactly the shape that trips it - so a retry has to give
# the limiter time to reopen. Three attempts back to back all land inside the same burst
# and turn a throttle into a failed run.
RETRY_BACKOFF = 1.5


def _widths(spec: Spec) -> int:
    return sum(np.dtype(dtype).itemsize for _, dtype, _ in spec)


def _decode(payload: bytes, spec: Spec, rows: int) -> dict[str, np.ndarray]:
    """Split one payload into its columns.

    Each column is a contiguous run of one fixed-width dtype, in the order the spec
    lists it, so the offsets are a running sum and nothing needs parsing. A `delta`
    column holds successive differences and is restored by a prefix sum - taken in
    int64 whatever the stored width, because a signed delta column goes backwards
    (the geometry tiles are in spatial order, where longitude resets westward at
    every row of latitude) and accumulating that in the narrow dtype would wrap.
    """
    expected = rows * _widths(spec)
    if len(payload) != expected:
        raise ValueError(f"expected {expected:,} bytes for {rows:,} rows, got {len(payload):,}")

    out: dict[str, np.ndarray] = {}
    offset = 0
    for name, dtype, encoding in spec:
        column = np.frombuffer(payload, dtype=dtype, count=rows, offset=offset)
        offset += rows * np.dtype(dtype).itemsize
        out[name] = column.cumsum(dtype="int64") if encoding == "delta" else column
    return out


def _store(dest: Path, body: bytes) -> None:
    """Write through a `.tmp` and rename, so an interruption leaves nothing partial.

    The same rule ingest follows for the raw layer, and it matters more here than it
    looks: a half-written file in the cache is indistinguishable from a complete one
    for any payload the manifest gives no length for.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".tmp")
    tmp.write_bytes(body)
    tmp.replace(dest)


def _get(
    client: httpx.Client,
    base: str,
    key: str,
    cache: Path,
    expected: int | None,
    offline: bool = False,
) -> bytes:
    """Fetch `key` once and keep it.

    The cache is what makes this restartable. It is ~1,480 requests against an
    `r2.dev` URL with no CDN in front of it, so a run that dies at file 900 must not
    begin again at nothing.

    A cached file is trusted at its exact expected length, which for a columnar payload
    is `rows x width` from the manifest. A truncated download is the failure this
    guards: it would otherwise decode into plausible numbers for however many rows
    arrived. The two JSON trees have no such length - the manifest records their
    *compressed* size and what arrives is decompressed - so their callers validate the
    decoded shape instead.

    `offline` refuses to reach the network at all rather than quietly filling gaps, so
    the flag means what it says. A cache primed elsewhere either decodes or fails
    loudly; it does not turn into a partial download nobody asked for.

    Every payload is stored brotli-compressed and served with `Content-Encoding: br`,
    so httpx has already decompressed what it returns and there is nothing to decode
    here beyond taking views at offsets.
    """
    dest = cache / key
    if dest.exists() and (expected is None or dest.stat().st_size == expected):
        return dest.read_bytes()
    if offline:
        raise SystemExit(f"--offline: {dest} is missing or the wrong length")

    last: Exception | None = None
    for attempt in range(RETRIES):
        if attempt:
            # Sleep before retrying, never after the last attempt. Without this a
            # rate-limited burst spends all three tries inside the same closed window.
            time.sleep(RETRY_BACKOFF * (2 ** (attempt - 1)))
        try:
            response = client.get(f"{base}/{key}")
            response.raise_for_status()
            body = response.content
            if expected is not None and len(body) != expected:
                raise ValueError(f"{key}: got {len(body):,} bytes, expected {expected:,}")
            _store(dest, body)
            return body
        except Exception as error:  # noqa: BLE001 - retried, then re-raised below
            last = error
    raise RuntimeError(f"{key} failed after {RETRIES} attempts") from last


def _fetch_all(
    client: httpx.Client,
    base: str,
    cache: Path,
    jobs: list[tuple[str, int | None]],
    offline: bool = False,
) -> list[bytes]:
    """Fetch in order, a few at a time. Order matters: callers index the result."""
    with ThreadPoolExecutor(max_workers=config.PUBLIC_WORKERS) as pool:
        return list(pool.map(lambda job: _get(client, base, job[0], cache, job[1], offline), jobs))


def _zones(
    client: httpx.Client,
    base: str,
    cache: Path,
    meta: dict[str, Any],
    names: bool,
    offline: bool = False,
) -> pl.DataFrame:
    """One row per zone: position, admin ids, `ZoneId`, and optionally the name.

    Positions are scattered rather than appended, because `tiles/` is sorted by
    latitude then longitude inside each tile and so carries `idx` as an explicit
    column. Writing each tile's rows to the slots its own `idx` names is what keeps
    the frame in index order without a sort.

    **The tiles have to account for every index.** Scattering leaves an unclaimed slot
    at zero, which is a real-looking zone off the Gulf of Guinea rather than a gap - and
    the export's own note is that idx and row order coincide only while nothing has ever
    left the scope, "not a property worth depending on". So it is checked rather than
    assumed: a tombstone would otherwise reach the warehouse as a place.
    """
    geometry = meta["geometry"]
    count = meta["scope"]["zone_count"]
    scale = geometry["coord_scale"]
    fields = geometry["tile_fields"]
    tiles = [dict(zip(fields, tile, strict=True)) for tile in geometry["tiles"]]

    total = sum(t["zones"] for t in tiles)
    if total != count:
        raise ValueError(
            f"tiles carry {total:,} zones but the scope names {count:,} - "
            "an index with no tile row would land at latitude 0, longitude 0"
        )

    latitude = np.zeros(count, dtype="int64")
    longitude = np.zeros(count, dtype="int64")
    region_id = np.zeros(count, dtype="uint16")
    country_id = np.zeros(count, dtype="uint16")
    ever_active = np.zeros(count, dtype="uint8")

    spec = geometry["position_columns"]
    width = _widths(spec)
    payloads = _fetch_all(
        client,
        base,
        cache,
        [(f"{geometry['paths']['tiles']}/{t['name']}.bin.br", t["zones"] * width) for t in tiles],
        offline,
    )
    for tile, payload in zip(tiles, payloads, strict=True):
        columns = _decode(payload, spec, tile["zones"])
        idx = columns["idx"]
        latitude[idx] = columns["latitude"]
        longitude[idx] = columns["longitude"]
        region_id[idx] = columns["region_id"]
        country_id[idx] = columns["country_id"]
        ever_active[idx] = columns["ever_active"]
    log.info("  positions: %s zones over %d tiles", f"{count:,}", len(tiles))

    ids = meta["zone_ids"]
    zone_id = _decode(
        _get(client, base, ids["path"], cache, ids["rows"] * _widths(ids["columns"]), offline),
        ids["columns"],
        ids["rows"],
    )["zone_id"]

    frame = pl.DataFrame(
        {
            "idx": np.arange(count, dtype="uint32"),
            "zone_id": zone_id.astype("int64"),
            "latitude": latitude / scale,
            "longitude": longitude / scale,
            "region_id": region_id.astype("int64"),
            "country_id": country_id.astype("int64"),
            "ever_active": ever_active.astype(bool),
        }
    )

    if not names:
        return frame.with_columns(name=pl.lit(None, dtype=pl.String))

    # Row `i` of block `B` is zone `B * block_size + i`, placed by index rather than
    # by row position, so a scope that left tombstones behind cannot shift them.
    #
    # The manifest's `bytes` for these is the *compressed* length and what arrives is
    # decompressed, so `_get` has nothing to check them against. The row count is the
    # check instead: a block short by one shifts every name after it within the block,
    # and the symptom is a hover confidently naming the wrong place.
    blocks = meta["names"]["blocks"]
    size = meta["names"]["block_size"]
    payloads = _fetch_all(
        client,
        base,
        cache,
        [(f"{meta['names']['path']}/{b[0]:04d}.json.br", None) for b in blocks],
        offline,
    )
    labels: list[str | None] = [None] * count
    for block, payload in zip(blocks, payloads, strict=True):
        names_in_block = json.loads(payload)
        if len(names_in_block) != block[1]:
            raise ValueError(
                f"names block {block[0]:04d}: {len(names_in_block):,} names, "
                f"manifest says {block[1]:,}"
            )
        start = block[0] * size
        for offset, label in enumerate(names_in_block):
            if start + offset < count:
                labels[start + offset] = label
    log.info("  names: %d blocks", len(blocks))
    return frame.with_columns(name=pl.Series(labels, dtype=pl.String))


def _events(
    client: httpx.Client,
    base: str,
    cache: Path,
    meta: dict[str, Any],
    offline: bool = False,
) -> pl.DataFrame:
    """Every event in the record, from `zone_history/`.

    Allocated once at the row count the manifest declares and filled block by block.
    Concatenating 655 frames instead would copy the whole stream again for no reason.

    A `seq` column carries the export's own row order, and it is load-bearing rather
    than decorative. The export is ordered `(idx, observed_at)` but stores only `day`,
    so the 653,071 zone-days holding more than one event arrive as tied rows - and a
    zone's state for a day is the *last* of them. Without a sequence there is nothing
    to order those ties by once SQL has touched the table, and "the standing at date D"
    silently becomes whichever event the planner emitted last.
    """
    history = meta["zone_history"]
    spec = history["columns"]
    width = _widths(spec)
    blocks = history["blocks"]
    total = sum(rows for _, rows, _ in blocks)

    columns = {
        name: np.zeros(total, dtype="int64" if encoding == "delta" else dtype)
        for name, dtype, encoding in spec
    }

    payloads = _fetch_all(
        client,
        base,
        cache,
        [(f"{history['path']}/{block:04d}.bin.br", rows * width) for block, rows, _ in blocks],
        offline,
    )
    at = 0
    for (_, rows, _), payload in zip(blocks, payloads, strict=True):
        for name, values in _decode(payload, spec, rows).items():
            columns[name][at : at + rows] = values
        at += rows

    log.info("  events: %s rows over %d blocks", f"{total:,}", len(blocks))
    return pl.DataFrame(
        {
            "seq": np.arange(total, dtype="int64"),
            **{name: values.astype("int64") for name, values in columns.items()},
        }
    )


def _maz(
    client: httpx.Client,
    base: str,
    cache: Path,
    meta: dict[str, Any],
    offline: bool = False,
) -> pl.DataFrame:
    """The Most Active Zones record, joined to its measures by row position.

    `maz_stats` carries no key columns at all: row *i* describes row *i* of `maz`, and
    `idx` joins on to everything else. The two payloads share a `group by` and an
    `order by` in the export, which is what makes position a valid join.

    Read from the manifest rather than a fixed list, because the measure columns have
    grown - a run against an older export simply returns fewer of them.
    """
    maz = meta["maz"]
    stats = maz["stats"]
    keys = _decode(
        _get(client, base, maz["path"], cache, maz["rows"] * _widths(maz["columns"]), offline),
        maz["columns"],
        maz["rows"],
    )
    measures = _decode(
        _get(
            client, base, stats["path"], cache, stats["rows"] * _widths(stats["columns"]), offline
        ),
        stats["columns"],
        stats["rows"],
    )
    log.info("  maz: %s reports, %d measures", f"{maz['rows']:,}", len(stats["columns"]))
    return pl.DataFrame(
        {name: values.astype("int64") for name, values in (keys | measures).items()}
    )


def _areas(
    client: httpx.Client,
    base: str,
    cache: Path,
    meta: dict[str, Any],
    offline: bool = False,
) -> tuple[pl.DataFrame, pl.DataFrame]:
    """Country and region lookups. Regions carry the country they belong under."""
    lookups = json.loads(_get(client, base, meta["lookups"]["path"], cache, None, offline))
    countries = pl.DataFrame(
        {
            "country_id": [int(k) for k in lookups["countries"]],
            "iso2": [v[0] for v in lookups["countries"].values()],
            "name": [v[1] for v in lookups["countries"].values()],
        }
    )
    regions = pl.DataFrame(
        {
            "region_id": [int(k) for k in lookups["regions"]],
            "name": [v[0] for v in lookups["regions"].values()],
            "country_id": [v[1] for v in lookups["regions"].values()],
        }
    )
    log.info("  lookups: %d countries, %d regions", countries.height, regions.height)
    return countries, regions


def _build(con: duckdb.DuckDBPyConnection, tables: Path, meta: dict[str, Any]) -> None:
    """Create the tables from the parquet dumps.

    Handed over as Parquet rather than by registering a polars frame, because that
    path goes through Arrow and needs pyarrow - a large dependency for one handoff,
    when both sides speak Parquet natively.
    """
    epoch = config.DAY_EPOCH.isoformat()

    con.execute(f"""
        create or replace table country as
        select * from read_parquet('{tables / "country.parquet"}')
    """)
    con.execute(f"""
        create or replace table region as
        select * from read_parquet('{tables / "region.parquet"}')
    """)
    # Parameterized rather than interpolated: these names come from a manifest fetched
    # over a URL the caller chooses with `--origin`, so they are remote input reaching
    # SQL. An apostrophe alone would be a syntax error and worse is available.
    con.execute("create or replace table faction (faction_id integer, faction varchar)")
    con.executemany(
        "insert into faction values (?, ?)",
        [(int(code), name) for code, name in meta["factions"].items()],
    )

    # `country_id` is authoritative and `region_id` is the corrupt field: for 447 zones
    # the region they point at belongs to a different country, and the coordinates back
    # the country every time. So the region label survives only where the region's own
    # country agrees, and a contradicted one comes back null rather than reaching across
    # an ocean. The same rule the map applies.
    con.execute(f"""
        create or replace table zone as
        select z.idx,
               z.zone_id,
               z.latitude,
               z.longitude,
               z.name,
               z.country_id,
               c.name as country,
               case when r.country_id = z.country_id then z.region_id end as region_id,
               case when r.country_id = z.country_id then r.name end     as region,
               z.ever_active
        from read_parquet('{tables / "zone.parquet"}') z
        left join country c on c.country_id = z.country_id
        left join region r on r.region_id = z.region_id
    """)

    # `day` is an offset from DAY_EPOCH, which is 2010-01-01 rather than the release
    # date so the 29 backfill sentinel rows are not negative.
    con.execute(f"""
        create or replace table zone_event as
        select e.seq,
               e.idx,
               z.zone_id,
               date '{epoch}' + cast(e.day as integer) as activity_date,
               e.control_state,
               e.legion_count,
               e.swarm_count,
               e.faceless_count,
               e.legion_count + e.swarm_count + e.faceless_count as total
        from read_parquet('{tables / "zone_event.parquet"}') e
        join zone z on z.idx = e.idx
    """)

    # A zone's standing for a day is the last event of that day, and its change is
    # against the last day it moved - not against the day before, which for most zones
    # holds no row at all. The changelog is sparse by design: 504,410 zones last changed
    # in 2019 or earlier, so anything that reads a missing day as a zero has thrown away
    # a third of the map. `delta` is therefore the step at each event day, and summing
    # those over a window is the net change across it.
    con.execute("""
        create or replace table zone_day as
        with standing as (
            select idx, zone_id, activity_date,
                   arg_max(control_state, seq) as control_state,
                   arg_max(legion_count, seq)  as legion_count,
                   arg_max(swarm_count, seq)   as swarm_count,
                   arg_max(faceless_count, seq) as faceless_count,
                   arg_max(total, seq)         as total,
                   count(*)                    as events
            from zone_event group by 1, 2, 3
        )
        select *,
               total - lag(total, 1, 0) over (partition by idx order by activity_date)
                   as delta
        from standing
    """)

    con.execute(f"""
        create or replace table maz as
        select m.* replace (date '{epoch}' + cast(m.day as integer) as day)
        from read_parquet('{tables / "maz.parquet"}') m
    """)
    con.execute("alter table maz rename column day to activity_date")


def _manifest(client: httpx.Client, base: str, cache: Path, offline: bool) -> dict[str, Any]:
    """The export's own manifest, normally fetched fresh.

    It is the one file the export writes last, precisely so a client reading it finds
    every shard it names - and a stale one names shards that no longer exist. So it is
    not cached like the rest.

    `offline` keeps a copy and reuses it, which is what makes a primed cache
    reproducible: the same bytes decode to the same warehouse a year later, and a run
    needs no network at all. It is a deliberate choice rather than a fallback, because
    a manifest silently older than the shards beside it is the failure mode worth
    refusing to arrive at by accident.
    """
    dest = cache / "meta.json"
    if offline:
        if not dest.exists():
            raise SystemExit(f"--offline needs a cached manifest at {dest}")
        log.info("  manifest: cached (offline)")
        return json.loads(dest.read_bytes())

    body = client.get(f"{base}/meta.json").raise_for_status().content
    # Parsed before it is stored, so a truncated or non-JSON response never becomes the
    # file `--offline` goes on to trust.
    manifest = json.loads(body)
    _store(dest, body)
    return manifest


def hydrate(base: str | None = None, names: bool = True, offline: bool = False) -> None:
    base = (base or config.PUBLIC_DATA_ORIGIN).rstrip("/") + "/global"
    cache = config.PUBLIC_CACHE
    tables = cache / "tables"
    tables.mkdir(parents=True, exist_ok=True)

    log.info("reading the published export from %s", base)
    with httpx.Client(
        timeout=config.PUBLIC_TIMEOUT, headers={"User-Agent": config.USER_AGENT}
    ) as client:
        meta = _manifest(client, base, cache, offline)
        log.info(
            "  %s zones, %s ever played, %s to %s",
            f"{meta['scope']['zone_count']:,}",
            f"{meta['scope']['active_count']:,}",
            *meta["date_range"],
        )

        countries, regions = _areas(client, base, cache, meta, offline)
        countries.write_parquet(tables / "country.parquet")
        regions.write_parquet(tables / "region.parquet")
        _zones(client, base, cache, meta, names, offline).write_parquet(tables / "zone.parquet")
        _events(client, base, cache, meta, offline).write_parquet(tables / "zone_event.parquet")
        _maz(client, base, cache, meta, offline).write_parquet(tables / "maz.parquet")

    con = duckdb.connect(str(config.PUBLIC_DUCKDB_PATH))
    try:
        _build(con, tables, meta)
        for table in ("zone", "zone_event", "zone_day", "maz", "country", "region"):
            rows = con.execute(f"select count(*) from {table}").fetchone()[0]
            log.info("  %-11s %s rows", table, f"{rows:,}")
    finally:
        con.close()

    log.info(
        "hydrate complete: %s. Day grain, no observed_at, and battlestats only as MAZ "
        "carries it - see the module docstring.",
        config.PUBLIC_DUCKDB_PATH,
    )
