"""Ingest Internet Archive snapshots of QONQR's Atlantis page."""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx

from . import atlantis, config

log = logging.getLogger(__name__)

CDX_URL = "https://web.archive.org/cdx/search/cdx"
WAYBACK_URL = "https://web.archive.org/web/{ts}id_/https://qonqr.com/Atlantis"

FETCH_INTERVAL = 3.0
MAX_ATTEMPTS = 3
TIMEOUT = 90.0


def _list_timestamps() -> list[str]:
    """Query the CDX API for all 200-status snapshots."""
    response = httpx.get(
        CDX_URL,
        params={
            "url": "qonqr.com/Atlantis",
            "output": "json",
            "fl": "timestamp",
            "filter": "statuscode:200",
        },
        timeout=TIMEOUT,
    )
    response.raise_for_status()
    rows = response.json()
    return [row[0] for row in rows[1:]]


def _snap_dir() -> Path:
    return config.RAW / "atlantis" / "wayback"


def _fetch_snapshot(ts: str) -> Path | None:
    """Download one snapshot, returning the path or None on failure."""
    path = _snap_dir() / f"{ts}.html"
    if path.exists():
        return path

    path.parent.mkdir(parents=True, exist_ok=True)
    url = WAYBACK_URL.format(ts=ts)

    for attempt in range(MAX_ATTEMPTS):
        if attempt > 0:
            time.sleep(FETCH_INTERVAL * (attempt + 1))
        try:
            response = httpx.get(url, timeout=TIMEOUT, follow_redirects=True)
            response.raise_for_status()
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(response.text, encoding="utf-8")
            tmp.replace(path)
            return path
        except httpx.HTTPError as exc:
            log.warning("wayback: %s attempt %d failed (%s)", ts, attempt + 1, exc)

    return None


def _parse_timestamp(ts: str) -> datetime:
    """Parse a Wayback timestamp like '20190719053422' to UTC datetime."""
    return datetime.strptime(ts, "%Y%m%d%H%M%S").replace(tzinfo=UTC)


def _ingest_one(path: Path) -> bool:
    """Parse and store one snapshot. Returns True if stored."""
    ts = path.stem
    observed_at = _parse_timestamp(ts)

    try:
        html = path.read_text(encoding="utf-8")
        page = atlantis.parse_page(html, observed_at, source="wayback")
    except (ValueError, IndexError, KeyError, AttributeError) as exc:
        log.warning("wayback: %s failed to parse (%s)", ts, exc)
        return False

    # A page with a winner before the tournament ends is the previous
    # month's frozen board, not a new observation.
    winner = page.tournament["Winner"][0]
    ends_at = page.tournament["EndsAtUtc"][0]
    naive_at = observed_at.replace(tzinfo=None)
    if winner is not None and ends_at is not None and naive_at < ends_at:
        raise ValueError(
            f"{ts}: banner says winner {winner} but observed_at {naive_at} < "
            f"ends_at {ends_at}; this is the previous month's frozen board"
        )

    atlantis._store(page, observed_at.replace(tzinfo=None))

    month = atlantis._month_start(observed_at.replace(tzinfo=None))
    schedule = f"({page.tournament['StackingDays'][0]},{page.tournament['BattleDays'][0]})"
    banner = winner or "?"
    log.info(
        "wayback: %s month=%s banner=%s schedule=%s lb=%d zones=%d",
        ts, month.strftime("%Y-%m"), banner, schedule,
        page.leaderboard.height, page.zones.height,
    )
    return True


def _fetch_missing(timestamps: list[str]) -> None:
    snap_dir = _snap_dir()
    on_disk = {p.stem for p in snap_dir.glob("*.html")} if snap_dir.exists() else set()
    to_fetch = [ts for ts in timestamps if ts not in on_disk]
    if not to_fetch:
        return
    log.info("wayback: fetching %d new snapshots", len(to_fetch))
    for ts in to_fetch:
        time.sleep(FETCH_INTERVAL)
        _fetch_snapshot(ts)


def ingest_wayback() -> int:
    """Fetch and ingest all available Wayback snapshots. Returns missing count."""
    timestamps = _list_timestamps()
    log.info("wayback: CDX lists %d snapshots", len(timestamps))

    _fetch_missing(timestamps)

    files = sorted(_snap_dir().glob("*.html"))
    parsed = 0
    failed = 0
    for p in files:
        if _ingest_one(p):
            parsed += 1
        else:
            failed += 1

    on_disk = {p.stem for p in _snap_dir().glob("*.html")} if _snap_dir().exists() else set()
    missing_ts = sorted(set(timestamps) - on_disk)

    log.info("wayback: parsed %d, failed %d, missing %d", parsed, failed, len(missing_ts))
    if missing_ts:
        log.warning("wayback: missing timestamps: %s", ", ".join(missing_ts))
    return len(missing_ts) + failed
