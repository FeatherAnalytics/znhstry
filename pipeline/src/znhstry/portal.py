"""Collect battle reports from QONQR's portal.

Battle reports are the one dataset QONQR does not publish as a file. They exist as HTML
at `portal.qonqr.com/Home/BattleStatistics/<BRN>`, one page per report, and the index of
which reports exist is the Most Active Zones page.

## What a battle report is

**A daily leaderboard entry, not a record of a fight.** The portal publishes ten reports
a day - the ten most active zones in the world - so a report means "this zone was among
the busiest today", which is a far stronger claim than a zone merely having an event.
Never describe this data as "battles that day": the other ~3,000 zones with activity are
not absent because they were quiet.

## Collecting it politely

This is the game's own live web server, not a bulk endpoint, and scraping it is tolerated
rather than invited. Three rules follow, and none of them should be relaxed:

- **Serial, with a floor between requests.** Ten pages a day does not need concurrency.
- **Only fetch what is missing.** The Most Active Zones page names today's ten; anything
  already on disk is skipped, so a normal run costs one index page and nothing else.
- **`PORTAL_MAX_PER_RUN` caps a catch-up.** A long outage must not turn into a crawl of
  thousands of pages. It resumes on the next run instead.

A report number that returns nothing is normal, not an error. The BRN range is sparse -
roughly 61,000 real reports across a span of 131,000 numbers - so misses are logged and
stepped over rather than raised. Because roughly half the range is empty, how far the
walk has got cannot be read off the reports on disk; `checked_through.txt` records it, or
a batch of dead numbers is re-walked every night forever.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
import polars as pl
from bs4 import BeautifulSoup

from . import config

log = logging.getLogger(__name__)

MAZ_URL = "https://portal.qonqr.com/Home/MostActiveZones"
REPORT_URL = "https://portal.qonqr.com/Home/BattleStatistics/{brn}"

# The portal renders thousands with a plain space: "1 666".
_THOUSANDS = " "

# Dates are US month-first: "8/7/2026" is the 7th of August. Parsed with an explicit
# format rather than a guesser, because for any day under 13 the wrong reading is also
# a valid date and the error would be invisible.
_DATE_FORMAT = "%m/%d/%Y"

# The six `progress` bars, in the order the page emits them.
_PROGRESS_FIELDS = (
    "Swarm Starting Bots",
    "Legion Starting Bots",
    "Faceless Starting Bots",
    "Swarm Ending Bots",
    "Legion Ending Bots",
    "Faceless Ending Bots",
)

BATTLESTATS_KEY = "Battle Report Number"


class ReportUnavailable(Exception):
    """This report number has no report behind it. Expected; the range is sparse."""


def _number(text: str) -> int:
    return int(text.replace(_THOUSANDS, "").strip())


def parse_report(brn: int, html: str) -> dict[str, Any]:
    """Turn one battle report page into a row.

    Column names are built from the page's own text - the stat label, and the faction
    from each cell's CSS class - which is what makes them match the seeded history
    exactly rather than approximately.
    """
    soup = BeautifulSoup(html, features="lxml")

    heading = soup.find("h1")
    if heading is None:
        raise ReportUnavailable(f"{brn}: no heading")
    bits = heading.get_text("\n", strip=True).split("\n")
    if len(bits) < 3 or bits[0] == "/":
        raise ReportUnavailable(f"{brn}: blank heading")

    region, _, country = bits[1].partition(" / ")
    stamp = soup.find("strong")
    if stamp is None or not stamp.string:
        raise ReportUnavailable(f"{brn}: no date")

    row: dict[str, Any] = {
        BATTLESTATS_KEY: brn,
        "Zone Name": bits[0],
        "Region": region,
        "Country": country,
        "Zone ID": int(bits[2].strip("#")),
        "Date": datetime.strptime(stamp.string.strip(), _DATE_FORMAT).date(),
    }

    bars = soup.find_all("div", class_="progress")
    if len(bars) != len(_PROGRESS_FIELDS):
        raise ReportUnavailable(f"{brn}: expected {len(_PROGRESS_FIELDS)} bars, got {len(bars)}")
    for field, bar in zip(_PROGRESS_FIELDS, bars, strict=True):
        row[field] = _number(bar.get_text(strip=True))

    for block in soup.find_all("div", class_="col-md-5"):
        parts = block.get_text("\n", strip=True).split("\n")
        stat = parts[0].strip(":")
        row[stat] = _number(parts[1])
        breakdown = block.find_next_sibling("div", class_="col-md-7")
        if breakdown is None:
            continue
        for cell in breakdown.find_all("td"):
            row[f"{cell.attrs['class'][0]} {stat}"] = _number(cell.get_text(strip=True))

    players = soup.select_one("div.col-sm-6 > div.table-responsive > table > tbody")
    row["players"] = players.get_text(",", strip=True).replace(" ", "") if players else None
    if not row["players"]:
        # The seeded history drops these, so keeping them would change the grain.
        raise ReportUnavailable(f"{brn}: no players")

    return row


def _client() -> httpx.Client:
    return httpx.Client(
        timeout=config.PORTAL_TIMEOUT,
        follow_redirects=True,
        headers={"User-Agent": config.USER_AGENT},
    )


def most_active_zones(client: httpx.Client) -> list[int]:
    """The report numbers on today's Most Active Zones page."""
    response = client.get(MAZ_URL)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, features="lxml")

    found: list[int] = []
    for link in soup.find_all("a", href=True):
        _, sep, tail = link["href"].partition("/Home/BattleStatistics/")
        if sep and tail.isdigit():
            found.append(int(tail))
    if not found:
        raise RuntimeError(f"no report links on {MAZ_URL}; the page layout has changed")
    return sorted(set(found))


def existing() -> pl.DataFrame | None:
    path = config.RAW / "battlestats" / "battlestats.parquet"
    return pl.read_parquet(path) if path.exists() else None


def _checked_path() -> Path:
    return config.RAW / "battlestats" / "checked_through.txt"


def checked_through() -> int:
    """The highest report number this pipeline has actually asked the portal for.

    Progress cannot be read off the reports on disk. Roughly half the numbers in the
    range have no report behind them, so a catch-up whose whole batch comes back empty
    adds nothing, leaves `max(have)` where it was, and walks the same dead numbers
    again on the next run and every run after it - a stall that is indistinguishable
    in the log from a night with nothing new.
    """
    path = _checked_path()
    if not path.exists():
        return 0
    try:
        return int(path.read_text(encoding="utf-8").strip())
    except ValueError:
        log.warning("%s is not a report number; starting the walk from what is on disk", path)
        return 0


def record_checked(highest: int) -> None:
    """Remember how far the walk got. Only ever forward, and written atomically."""
    if highest <= checked_through():
        return
    path = _checked_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(f"{highest}\n", encoding="utf-8")
    tmp.replace(path)


def _targets(listed: list[int], have: set[int], checked: int = 0) -> list[int]:
    """Which report numbers to fetch: today's, plus any gap below them.

    The index page only ever names today's ten. A run that was missed leaves reports
    that appear on no index anywhere, so the span between what we hold and what is
    listed has to be walked by number - which is also why the cap exists.

    The walk resumes from whichever is further along: the newest report on disk, or
    the highest number already checked. Numbers below that were asked for and had
    nothing behind them, which is the normal case rather than a fault.
    """
    wanted = set(listed)
    floor = max(max(have, default=0), checked)
    if floor:
        wanted |= set(range(floor + 1, max(listed)))
    return sorted(wanted - have)[: config.PORTAL_MAX_PER_RUN]


def scrape_battlestats() -> int:
    """Fetch any battle reports we do not have. Returns the number added."""
    current = existing()
    have = set(current[BATTLESTATS_KEY].to_list()) if current is not None else set()

    with _client() as client:
        listed = most_active_zones(client)
        log.info("most active zones lists %d reports, %s-%s", len(listed), listed[0], listed[-1])

        targets = _targets(listed, have, checked_through())
        if not targets:
            log.info("battlestats: already current at %s", max(have) if have else "nothing")
            return 0

        log.info("battlestats: fetching %d report(s)", len(targets))
        rows: list[dict[str, Any]] = []
        missing = 0
        unparsed = 0
        reached = 0
        for brn in targets:
            time.sleep(config.PORTAL_MIN_INTERVAL)
            try:
                response = client.get(REPORT_URL.format(brn=brn))
                response.raise_for_status()
            except httpx.HTTPError as exc:
                # Stop rather than hammer a server that is already unhappy. Whatever was
                # parsed so far is still worth keeping, and the rest resumes next run.
                log.warning("portal request failed at %s (%s); stopping here", brn, exc)
                break

            reached = brn
            try:
                rows.append(parse_report(brn, response.text))
            except ReportUnavailable as exc:
                missing += 1
                log.debug("skipped %s", exc)
            except (ValueError, IndexError, KeyError) as exc:
                # One page the parser cannot read must not throw away the other 39 this
                # run already paid for - and since the step is continue-on-error, an
                # escaping exception means the same pages are fetched again tomorrow and
                # discarded again. Narrow on purpose: these are what the parser raises
                # when the page's shape has moved, and each one is logged by number so a
                # layout change is visible rather than merely survived.
                unparsed += 1
                log.warning("report %s did not parse (%s: %s)", brn, type(exc).__name__, exc)

    if missing:
        log.info("battlestats: %d report number(s) had no report, which is normal", missing)
    if unparsed:
        log.warning("battlestats: %d report(s) fetched but not parsed", unparsed)
    # Before the merge: a run that fetched nothing usable still made progress through
    # the range, and that is exactly the run whose progress is otherwise invisible.
    if reached:
        record_checked(reached)
    if not rows:
        return 0

    return merge_battlestats(pl.DataFrame(rows))


def merge_battlestats(incoming: pl.DataFrame) -> int:
    """Fold reports into the raw layer, keyed on report number. Returns rows added."""
    path = config.RAW / "battlestats" / "battlestats.parquet"
    before = 0
    if path.exists():
        current = pl.read_parquet(path)
        before = current.height
        incoming = pl.concat([current, incoming], how="diagonal_relaxed")

    merged = incoming.unique(subset=[BATTLESTATS_KEY], keep="last", maintain_order=True).sort(
        BATTLESTATS_KEY
    )

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    merged.write_parquet(tmp, compression="zstd")
    tmp.replace(path)

    added = merged.height - before
    log.info(
        "battlestats: %s reports (+%s), through %s",
        f"{merged.height:,}",
        f"{added:,}",
        merged["Date"].max(),
    )
    return added
