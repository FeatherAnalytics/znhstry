"""Extract the QONQR mirror into local Parquet.

Every step is idempotent: a chunk whose Parquet file already exists is skipped,
so an interrupted run resumes by re-running the same command.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import polars as pl

from . import config
from .api import query

log = logging.getLogger(__name__)

CHANGELOG_COLUMNS = (
    "ZoneId",
    "LastUpdateDateUtc",
    "DateCapturedUtc",
    "ZoneControlState",
    "LegionCount",
    "SwarmCount",
    "FacelessCount",
)

ZONE_COLUMNS = (
    "ZoneId",
    "Description",
    "RegionId",
    "CountryId",
    "ZoneControlState",
    "DateCapturedUtc",
    "LastUpdateDateUtc",
    "Latitude",
    "Longitude",
    "LegionCount",
    "SwarmCount",
    "FacelessCount",
    "TotalCount",
)

_DATETIME_COLUMNS = {"LastUpdateDateUtc", "DateCapturedUtc"}
_COUNT_COLUMNS = {"LegionCount", "SwarmCount", "FacelessCount", "TotalCount"}


def _normalise(rows: list[dict], columns: tuple[str, ...]) -> pl.DataFrame:
    """Build a frame with stable dtypes so every chunk's Parquet matches."""
    if not rows:
        return pl.DataFrame(schema={c: pl.Null for c in columns})

    df = pl.DataFrame(rows, infer_schema_length=None)
    casts = []
    for column in columns:
        if column in _DATETIME_COLUMNS:
            expr = pl.col(column)
            if df.schema[column] == pl.String:
                expr = expr.str.to_datetime("%Y-%m-%d %H:%M:%S", strict=False)
            casts.append(expr.cast(pl.Datetime("us")).alias(column))
        elif column in _COUNT_COLUMNS:
            casts.append(pl.col(column).cast(pl.Int64).alias(column))
        elif column in {"ZoneId", "RegionId", "CountryId"}:
            casts.append(pl.col(column).cast(pl.Int32).alias(column))
        elif column == "ZoneControlState":
            casts.append(pl.col(column).cast(pl.Int8).alias(column))
        elif column in {"Latitude", "Longitude"}:
            casts.append(pl.col(column).cast(pl.Float64).alias(column))
        else:
            casts.append(pl.col(column).cast(pl.String).alias(column))
    return df.select(casts)


def _write(df: pl.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".parquet.tmp")
    df.write_parquet(tmp, compression="zstd")
    tmp.replace(path)  # atomic, so an interrupted write never leaves a half file


def _run_chunks(jobs: list[tuple[Path, str, tuple[str, ...]]], label: str) -> None:
    """Fetch and write chunks in parallel, skipping any already on disk."""
    pending = [job for job in jobs if not job[0].exists()]
    if not pending:
        log.info("%s: all %d chunks already present", label, len(jobs))
        return

    log.info("%s: %d/%d chunks to fetch", label, len(pending), len(jobs))
    done = 0

    def fetch(job: tuple[Path, str, tuple[str, ...]]) -> tuple[Path, int]:
        path, sql, columns = job
        rows = query(sql)
        _write(_normalise(rows, columns), path)
        return path, len(rows)

    with ThreadPoolExecutor(max_workers=config.MAX_WORKERS) as pool:
        for path, count in pool.map(fetch, pending):
            done += 1
            log.info("  [%d/%d] %s - %s rows", done, len(pending), path.name, f"{count:,}")


def _month_starts(start: date, end: date) -> Iterator[date]:
    current = date(start.year, start.month, 1)
    while current <= end:
        yield current
        current = (
            date(current.year + 1, 1, 1)
            if current.month == 12
            else date(current.year, current.month + 1, 1)
        )


def changelog_windows(today: date | None = None) -> list[tuple[str, date, date]]:
    """Yearly windows while history is sparse, monthly once it gets dense."""
    today = today or date.today()
    windows: list[tuple[str, date, date]] = []

    for year in range(config.HISTORY_START.year, config.MONTHLY_FROM_YEAR):
        windows.append((f"{year}", date(year, 1, 1), date(year + 1, 1, 1)))

    monthly_start = date(config.MONTHLY_FROM_YEAR, 1, 1)
    end = date(today.year, today.month, 1)
    end = date(end.year + 1, 1, 1) if end.month == 12 else date(end.year, end.month + 1, 1)
    months = list(_month_starts(monthly_start, end))
    for current, following in zip(months, months[1:]):
        windows.append((current.strftime("%Y-%m"), current, following))

    return windows


def extract_changelog() -> None:
    """Pull every changelog window that is not already on disk.

    The window covering today is the exception, and it is always refetched.
    A window is only immutable once it has *ended*, and the extractor's rule is
    otherwise "skip what is on disk". A run part-way through a month therefore
    writes a shard holding that month up to that instant, and without this every
    later run skips it as present - leaving a silently truncated tail that looks
    exactly like a quiet day upstream. Verify the tail against the API after any
    extraction; never assume a thin final day is real.
    """
    current = _current_window_label()
    jobs = []
    for label, start, end in changelog_windows():
        path = config.RAW / "changelog" / f"changelog_{label}.parquet"
        if label == current and path.exists():
            path.unlink()
        sql = (
            f"SELECT {', '.join(CHANGELOG_COLUMNS)} FROM changelog "
            f"WHERE LastUpdateDateUtc >= '{start}' AND LastUpdateDateUtc < '{end}'"
        )
        jobs.append((path, sql, CHANGELOG_COLUMNS))
    _run_chunks(jobs, "changelog")


def extract_baseline() -> None:
    """The 29 pre-2012 sentinel rows that actually carry bots.

    Every other sentinel row is zero, so this is the whole of the starting
    state. One slow full scan, run once.
    """
    path = config.RAW / "changelog" / "changelog_baseline.parquet"
    if path.exists():
        log.info("baseline: already present")
        return
    sql = (
        f"SELECT {', '.join(CHANGELOG_COLUMNS)} FROM changelog "
        f"WHERE LastUpdateDateUtc < '{config.SENTINEL_CUTOFF}' "
        "AND (LegionCount + SwarmCount + FacelessCount) > 0"
    )
    log.info("baseline: scanning for nonzero sentinel rows (slow, ~2-3 min)")
    rows = query(sql)
    _write(_normalise(rows, CHANGELOG_COLUMNS), path)
    log.info("baseline: %d rows", len(rows))


def extract_zones() -> None:
    zone_id_max = query("SELECT MAX(ZoneId) AS m FROM zones")[0]["m"]
    log.info("zones: max ZoneId is %s", f"{zone_id_max:,}")

    jobs = []
    upper = zone_id_max + config.ZONE_ID_HEADROOM
    for lo in range(0, upper, config.ZONE_ID_CHUNK):
        hi = lo + config.ZONE_ID_CHUNK
        sql = (
            f"SELECT {', '.join(ZONE_COLUMNS)} FROM zones "
            f"WHERE ZoneId >= {lo} AND ZoneId < {hi}"
        )
        jobs.append((config.RAW / "zones" / f"zones_{lo:08d}.parquet", sql, ZONE_COLUMNS))
    _run_chunks(jobs, "zones")


def extract_lookups() -> None:
    lookups = {
        "factions": ("SELECT id, name FROM factions", ("id", "name")),
        "countries": (
            "SELECT countryid, Code, Description FROM countries",
            ("countryid", "Code", "Description"),
        ),
        "regions": (
            "SELECT countryid, regionid, description FROM regions",
            ("countryid", "regionid", "description"),
        ),
    }
    for name, (sql, columns) in lookups.items():
        path = config.RAW / "lookups" / f"{name}.parquet"
        if path.exists():
            continue
        rows = query(sql)
        _write(pl.DataFrame(rows, infer_schema_length=None).select(columns), path)
        log.info("lookups: %s - %d rows", name, len(rows))


def extract_all() -> None:
    extract_lookups()
    extract_zones()
    extract_changelog()
    extract_baseline()


def _current_window_label(today: date | None = None) -> str:
    today = today or date.today()
    for label, start, end in changelog_windows(today):
        if start <= today < end:
            return label
    raise RuntimeError(f"no changelog window covers {today}")


def extract_update() -> None:
    """Nightly refresh: refetch only what can have changed.

    `zones` is overwritten in place upstream, so its shards are always stale.
    `changelog` is append-only, so only the window covering today can have
    grown -- everything older has ended and is skipped by the idempotent check.
    That is roughly 16 requests a night against a shared research box, rather
    than the 88 a full extraction costs.

    Clearing the current changelog window now lives in `extract_changelog`,
    because a partial window must never be trusted whichever entry point wrote
    it. This step only has to deal with `zones`.
    """
    log.info("update: refetching changelog window %s", _current_window_label())

    stale = list((config.RAW / "zones").glob("*.parquet"))
    for shard in stale:
        shard.unlink()
    log.info("update: refetching %d zone shards", len(stale))

    extract_all()
