"""Read QONQR's published Dropbox drop into `data/raw`.

This is the live ingest path. It replaces querying the SQL mirror, which was only ever
reading an accumulation of these same files - verified over a full ring: 83,870 events
either side, no row present in one and absent from the other, no differing value.

## The ring

`dailyzoneupdates-NN.csv` is a 31-slot ring where `NN` is the day of the month and
QONQR overwrites the slot in place. Nothing in the filename says which month, so a
stale slot is indistinguishable from a fresh one until it is parsed - slot 03 holding
July while slot 01 holds August is the normal resting state for the first days of a
month, not a fault.

Two consequences shape everything here:

- **The dates inside the file are the only truth.** There is no Last-Modified header on
  a Dropbox download, and the filename carries no year. Every freshness decision reads
  the parsed timestamps.
- **A gap wider than the ring is permanent.** Slot NN is gone the moment QONQR writes
  next month's day NN over it. `plan_slots` refuses to run rather than write a hole.

## What a slot contains

The dump is generated shortly after midnight UTC, so slot `NN` holds the events of day
`NN` plus the first seconds of day `NN+1`. Days therefore overlap by a sliver between
consecutive slots, which is why the merge is keyed rather than appended: re-reading a
slot already on disk is a no-op, and that is what makes a retried run free.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path

import httpx
import polars as pl

from . import config
from .schema import CHANGELOG_DTYPES, EVENT_KEY, ZONE_DTYPES, conform

log = logging.getLogger(__name__)

DAILY_STEM = "dailyzoneupdates"

# QONQR writes the CSV with 7 fractional-second digits. The mirror stores whole seconds
# and the warehouse is built on those, so the fraction is truncated rather than rounded
# - truncation is what the upstream importer does, and matching it exactly is what makes
# the two sources reconcile row for row.
_TIMESTAMP_WIDTH = 19
_TIMESTAMP_FORMAT = "%Y-%m-%d %H:%M:%S"


class RingGapError(RuntimeError):
    """The missing window is wider than the ring, so the data is unrecoverable."""


def links() -> dict[str, str]:
    """Filename -> URL, from the vendored link list."""
    out: dict[str, str] = {}
    for line in config.DROPBOX_LINKS.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        out[line.rsplit("/", 1)[-1]] = line
    return out


def slot_name(slot: int) -> str:
    return f"{DAILY_STEM}-{slot:02d}.csv"


def _download(client: httpx.Client, url: str, dest: Path) -> int:
    """Fetch one file, writing through a temporary so a failure leaves no partial."""
    joiner = "&" if "?" in url else "?"
    response = client.get(f"{url}{joiner}{config.DROPBOX_DOWNLOAD_PARAM}")
    response.raise_for_status()
    body = response.content

    # Dropbox answers 200 with a web page when it decides the caller is a browser, so a
    # status check alone would happily write HTML into a .csv and fail much later.
    if not body.startswith(b"ZoneId,") and not body.startswith(b"countryid,"):
        head = body[:80].decode("utf-8", "replace")
        raise RuntimeError(f"{dest.name}: expected CSV, got {head!r}")

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    tmp.write_bytes(body)
    tmp.replace(dest)
    return len(body)


def fetch(names: Iterable[str], dest_dir: Path | None = None) -> list[Path]:
    """Download the named files into the landing directory.

    A name absent from the link list is fatal. Dropbox has no listing API here, so the
    keys are pinned by hand - if QONQR re-shares the folder every key changes at once,
    and continuing past that would quietly ingest nothing at all.
    """
    dest_dir = dest_dir or config.LANDING
    available = links()
    names = list(names)

    unknown = [n for n in names if n not in available]
    if unknown:
        raise RuntimeError(
            f"no link for {unknown}. If the shared folder was re-shared, every key in "
            f"{config.DROPBOX_LINKS.name} needs refreshing."
        )

    paths: list[Path] = []
    with httpx.Client(
        timeout=config.DROPBOX_TIMEOUT,
        follow_redirects=True,
        headers={"User-Agent": config.USER_AGENT},
    ) as client:

        def one(name: str) -> tuple[Path, int]:
            path = dest_dir / name
            return path, _download(client, available[name], path)

        with ThreadPoolExecutor(max_workers=config.DROPBOX_WORKERS) as pool:
            for path, size in pool.map(one, names):
                log.info("fetched %s (%s KB)", path.name, f"{size // 1024:,}")
                paths.append(path)

    return paths


def read_daily(paths: Iterable[Path]) -> pl.DataFrame:
    """Parse daily CSVs into the changelog contract.

    Rows with no `LastUpdateDateUtc` are zones that have never been touched. They carry
    no event and the upstream importer drops them too.
    """
    frames = [pl.read_csv(p, infer_schema_length=None) for p in paths]
    if not frames:
        return pl.DataFrame(schema=CHANGELOG_DTYPES)

    df = pl.concat(frames, how="vertical_relaxed").filter(pl.col("LastUpdateDateUtc").is_not_null())
    df = df.with_columns(
        [
            pl.col(c)
            .cast(pl.String)
            .str.slice(0, _TIMESTAMP_WIDTH)
            .str.to_datetime(_TIMESTAMP_FORMAT, strict=False)
            for c in ("LastUpdateDateUtc", "DateCapturedUtc")
        ]
    )
    return conform(df, CHANGELOG_DTYPES).unique(subset=EVENT_KEY, keep="last")


def history_max(source: Path | None = None) -> date | None:
    """The newest event date already on disk, or None if there is no history yet."""
    source = source or config.RAW / "changelog"
    parts = sorted(source.rglob("*.parquet"))
    if not parts:
        return None
    newest = (
        pl.scan_parquet([str(p) for p in parts])
        .select(pl.col("LastUpdateDateUtc").max())
        .collect()
        .item()
    )
    return None if newest is None else newest.date()


def plan_slots(today: date | None = None, source: Path | None = None) -> list[int]:
    """Which ring slots this run needs, derived from the history rather than the date.

    Normally one: the day that closed at midnight. A run that was skipped or failed
    widens the window on its own, so a missed night heals on the next run without
    anybody re-running it with arguments.

    The ring is the limit. Past `RING_SLOTS` days the oldest missing slot has already
    been overwritten with a newer month, and fetching it would append the wrong month's
    events while reporting success - so this raises instead.
    """
    today = today or date.today()
    # The dump for day D lands just after D ends, so D itself is never complete yet.
    newest_complete = today - timedelta(days=1)

    have = history_max(source)
    if have is None:
        raise RingGapError(
            "no history on disk. The ring only reaches back 31 days, so a first run "
            "must be seeded from an archive - see `znhstry restore`."
        )

    # Day D is fully read only once events *after* it are on disk. Because a slot spans
    # midnight, reading slot D leaves the first seconds of D+1 behind as proof; a max of
    # D alone means slot D-1 was the last one read and D is still a sliver. Comparing
    # dates the obvious way would mistake that sliver for a finished day - the same
    # "thin final day" that has bitten this pipeline before.
    if have > newest_complete:
        log.info("history reaches %s; %s is fully read", have, newest_complete)
        return []

    days = [have + timedelta(days=n) for n in range((newest_complete - have).days + 1)]
    if len(days) > config.RING_SLOTS:
        raise RingGapError(
            f"history ends {have} and {newest_complete} just closed: {len(days)} days "
            f"to read, but the ring only holds {config.RING_SLOTS}. The oldest of those "
            "slots has been overwritten with a newer month and is not recoverable from "
            "Dropbox. Restore from the archive instead of running this."
        )

    log.info("history reaches %s, reading %d slot(s) up to %s", have, len(days), newest_complete)
    return [d.day for d in days]


# --- The history, partitioned by year -------------------------------------
#
# The old layout was 88 shards - yearly to 2019, monthly after - sized purely so no
# single API response was enormous. With no API there is no reason to carry that shape,
# and it made a nightly append touch a 156 MB spread to add one day.
#
# A year partition is the natural grain instead: an append rewrites the current year and
# nothing else, DuckDB prunes whole files from the directory name, and 16 files is a
# layout a person can look at. Rows sort by `(ZoneId, LastUpdateDateUtc)` within a
# partition, which is both a total order - the key is unique across all 9.88M rows - and
# the order that compresses, since it puts each zone's trajectory together.


def partition_path(year: int) -> Path:
    return config.RAW / "changelog" / f"year={year}" / "events.parquet"


def _write_partition(df: pl.DataFrame, year: int) -> None:
    path = partition_path(year)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    df.sort(EVENT_KEY).write_parquet(tmp, compression="zstd")
    tmp.replace(path)


def merge(events: pl.DataFrame) -> dict[int, int]:
    """Fold events into their year partitions. Returns rows added per year.

    Keyed rather than appended, so running twice over the same slot adds nothing. Where
    a key already exists the incoming row wins: values should be identical, but if
    QONQR ever corrects one, the correction is the thing worth keeping.
    """
    if events.is_empty():
        return {}

    added: dict[int, int] = {}
    for (year,), incoming in events.group_by(
        pl.col("LastUpdateDateUtc").dt.year(), maintain_order=True
    ):
        path = partition_path(int(year))
        before = 0
        if path.exists():
            existing = pl.read_parquet(path)
            before = existing.height
            incoming = pl.concat([existing, incoming], how="vertical")

        merged = incoming.unique(subset=EVENT_KEY, keep="last", maintain_order=True)
        _write_partition(merged, int(year))
        added[int(year)] = merged.height - before
        log.info("year=%s: %s rows (+%s)", year, f"{merged.height:,}", f"{added[int(year)]:,}")

    return added


# --- zones and lookups ----------------------------------------------------
#
# The same daily CSV that carries the day's events also carries a complete `zones` row
# for every zone it mentions - name, position, country, region, current counts. So the
# current-state table is maintained by upsert from the file already in hand, and the
# 16-request nightly re-pull of all 2.68M zones goes away with it.
#
# One file, not the old 200k-id chunks. That chunking sized SQL queries, and an upsert
# touching ~3,000 scattered zones rewrote every chunk anyway.

ZONES_PATH_NAME = "zones.parquet"


def zones_path() -> Path:
    return config.RAW / "zones" / ZONES_PATH_NAME


def read_zone_state(paths: Iterable[Path]) -> pl.DataFrame:
    """Parse daily CSVs into the zones contract.

    `TotalCount` is recomputed rather than read: upstream stores it, but a stored total
    that disagrees with its three parts is a lie the map would draw.
    """
    frames = [pl.read_csv(p, infer_schema_length=None) for p in paths]
    if not frames:
        return pl.DataFrame(schema=ZONE_DTYPES)

    df = pl.concat(frames, how="vertical_relaxed").with_columns(
        [
            pl.col(c)
            .cast(pl.String)
            .str.slice(0, _TIMESTAMP_WIDTH)
            .str.to_datetime(_TIMESTAMP_FORMAT, strict=False)
            for c in ("LastUpdateDateUtc", "DateCapturedUtc")
        ]
    )
    df = df.with_columns(
        (
            pl.col("LegionCount").cast(pl.Int64)
            + pl.col("SwarmCount").cast(pl.Int64)
            + pl.col("FacelessCount").cast(pl.Int64)
        ).alias("TotalCount")
    )
    return conform(df, ZONE_DTYPES)


def merge_zones(incoming: pl.DataFrame) -> tuple[int, int]:
    """Upsert current state by zone. Returns (total zones, zones changed).

    The newest observation wins, decided by `LastUpdateDateUtc` rather than by which
    file was read last. Reading an old slot by hand must never roll a zone backwards,
    and nulls sort first so a never-touched row cannot displace a real one.
    """
    if incoming.is_empty():
        return 0, 0

    path = zones_path()
    before = 0
    if path.exists():
        existing = pl.read_parquet(path)
        before = existing.height
        incoming = pl.concat([existing, incoming], how="vertical")

    merged = (
        incoming.sort("ZoneId", "LastUpdateDateUtc", nulls_last=False)
        .unique(subset=["ZoneId"], keep="last", maintain_order=True)
        .sort("ZoneId")
    )

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    merged.write_parquet(tmp, compression="zstd")
    tmp.replace(path)

    new_zones = merged.height - before
    log.info("zones: %s rows (+%s new)", f"{merged.height:,}", f"{new_zones:,}")
    return merged.height, new_zones


def ingest_lookups() -> None:
    """Countries and Regions, straight from the drop.

    Both CSVs already carry exactly the column names the warehouse reads
    (`countryid,Code,Description` and `countryid,regionid,description`), so there is
    nothing to rename - only a cast, so the ids do not drift between runs.
    """
    paths = {p.name: p for p in fetch(["Countries.csv", "Regions.csv"])}
    for name, source, dtypes in (
        (
            "countries",
            "Countries.csv",
            {"countryid": pl.Int64, "Code": pl.String, "Description": pl.String},
        ),
        (
            "regions",
            "Regions.csv",
            {"countryid": pl.Int64, "regionid": pl.Int64, "description": pl.String},
        ),
    ):
        df = conform(pl.read_csv(paths[source], infer_schema_length=None), dtypes)
        out = config.RAW / "lookups" / f"{name}.parquet"
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(out.name + ".tmp")
        df.write_parquet(tmp, compression="zstd")
        tmp.replace(out)
        log.info("lookups: %s - %s rows", name, f"{df.height:,}")


def ingest_daily(slots: Iterable[int] | None = None, today: date | None = None) -> dict[int, int]:
    """The nightly step: work out which slots are needed, read them, fold them in.

    `slots` overrides the plan. That is the manual escape hatch for the rare case where
    a specific slot has to be re-read - a dump that landed late, or one QONQR corrected
    after the fact - and it deliberately skips the gap check, because an operator asking
    for a named slot already knows what they are asking for.
    """
    chosen = list(slots) if slots is not None else plan_slots(today)
    if not chosen:
        log.info("nothing to ingest")
        return {}

    paths = fetch([slot_name(s) for s in chosen])

    events = read_daily(paths)
    log.info("read %s events from %d slot(s)", f"{events.height:,}", len(chosen))
    added = merge(events)

    # Same files, read a second way. The event stream is the record; `zones` is the
    # current-state view the geometry and labels come from, and both are in the CSV.
    merge_zones(read_zone_state(paths))
    ingest_lookups()

    return added


# --- battlestats ----------------------------------------------------------
#
# Battle reports are the one dataset QONQR does not put in the Dropbox drop. They live
# on `portal.qonqr.com`, one HTML page per battle report number, and the history was
# scraped over years by neon-ninja. Re-scraping it ourselves would mean ~130,000
# sequential page fetches to recover ~61,000 rows, because the BRN range is sparse -
# a lot of load on the game's own server to reproduce something that already exists.
#
# So the history is copied once, and collection from here on is ours. This is a seed,
# not a dependency: nothing on a schedule reads their repo, and the function takes a
# path so a future scraper can append through the same contract.


def seed_battlestats(csv_path: Path) -> int:
    """Land a battlestats CSV in the raw layer, verbatim.

    All 77 columns, names and spaces intact. Renaming and filtering belong in dbt,
    where they are visible and testable; the raw layer's job is to be a faithful copy
    of what arrived. Only the three columns everything joins on are typed here, so a
    later append cannot silently land `Zone ID` as a string.
    """
    df = pl.read_csv(csv_path, infer_schema_length=None).with_columns(
        [
            pl.col("Battle Report Number").cast(pl.Int64),
            pl.col("Zone ID").cast(pl.Int64, strict=False),
            pl.col("Date").cast(pl.String).str.slice(0, 10).str.to_date("%Y-%m-%d", strict=False),
        ]
    )
    df = df.unique(subset=["Battle Report Number"], keep="last").sort("Battle Report Number")

    out = config.RAW / "battlestats" / "battlestats.parquet"
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    df.write_parquet(tmp, compression="zstd")
    tmp.replace(out)

    log.info(
        "battlestats: %s reports, %s to %s",
        f"{df.height:,}",
        df["Date"].min(),
        df["Date"].max(),
    )
    return df.height
