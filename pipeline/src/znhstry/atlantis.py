"""Collect the Atlantis tournament page from QONQR's portal.

Atlantis is the monthly tournament: nineteen zones with no geography, fought over a few
days, with a per-faction leaderboard of launches. `portal.qonqr.com/Atlantis` renders all
of it on one page, so a run is one GET - the schedule, the rules, every zone's counts and
up to three hundred leaderboard rows come back together.

The page also says when it ends. "Stacking Days: N  Battle Days: M" plus the start at
00:00 UTC on the 1st gives `ends_at`, and the run after that instant is the final pull.
`state.json` records `next_run_at` for the workflow gate: hourly while the battle is on,
then the 1st of the following month. It is the only thing the gate reads, so every run
writes it, including the ones that parse nothing.

`Zone` is a position, not a name. The site names each faction's zones after its top three
players and the month's formation rules, so the names change monthly and a player's name
can be a zone's name at the same time. `Prime` and `"{faction} {position}"` are stable
across tournaments; `zone_months` records what each position was called.

Same stance as `portal`: a page the parser cannot read is logged and skipped, never raised.
HTTP failures propagate; the workflow step tolerates them.
"""

from __future__ import annotations

import json
import logging
import re
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

import polars as pl
from bs4 import BeautifulSoup, Tag

from . import config
from .portal import _client, _number
from .schema import (
    ATLANTIS_LEADERBOARD_DTYPES,
    ATLANTIS_LEADERBOARD_KEY,
    ATLANTIS_TOURNAMENT_DTYPES,
    ATLANTIS_TOURNAMENT_KEY,
    ATLANTIS_ZONE_DTYPES,
    ATLANTIS_ZONE_KEY,
    ATLANTIS_ZONE_MONTH_DTYPES,
    ATLANTIS_ZONE_MONTH_KEY,
    conform,
)

log = logging.getLogger(__name__)

ATLANTIS_URL = "https://portal.qonqr.com/Atlantis"

FACTIONS = ("Swarm", "Legion", "Faceless")

_SCHEDULE = re.compile(r"Stacking Days:\s*(\d+)\s+Battle Days:\s*(\d+)")

# The banner's h1 during a battle is "The battle for Atlantis is under way."; after the end
# it names the winner, and keeps naming them until the next tournament starts.
_WINNER = re.compile(r"The (Swarm|Legion|Faceless) are victorious!")

# Prime, then the six positions of every faction's triangle: three player zones and three
# formation zones. The rules block lists exactly one rule per position, in this order.
_POSITIONS = 6
_ZONE_COUNT = 1 + len(FACTIONS) * _POSITIONS

# Only the formation zones carry a faction letter; the player zones are named after players.
_FORMATION_PREFIX = {"L ": "Legion", "S ": "Swarm", "F ": "Faceless"}

_CUBES_ALLOWED = "refresh/recharge is allowed"


def _next_hour(moment: datetime) -> datetime:
    # The top of the next hour, not observed_at + 1h: the cron fires at the same minute
    # every hour, so a due time a few seconds past that minute would skip every other run.
    return moment.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)


class LayoutChanged(Exception):
    """The page is not shaped the way the parser expects. Logged and skipped, never raised."""


@contextmanager
def _section(name: str):
    try:
        yield
    except (ValueError, IndexError, KeyError, AttributeError, TypeError) as exc:
        raise LayoutChanged(f"{name}: {type(exc).__name__}: {exc}") from exc


@dataclass(frozen=True)
class Schedule:
    month: date
    stacking_days: int
    battle_days: int

    @property
    def ends_at(self) -> datetime:
        start = datetime(self.month.year, self.month.month, 1)
        return start + timedelta(days=self.stacking_days + self.battle_days)


@dataclass(frozen=True)
class ParsedPage:
    leaderboard: pl.DataFrame
    zones: pl.DataFrame
    zone_months: pl.DataFrame
    tournament: pl.DataFrame
    schedule: Schedule


# --- parsing ----------------------------------------------------------------


def _faction_of(tag: Tag) -> str | None:
    return next((c for c in tag.get("class", []) if c in FACTIONS), None)


def _month_start(moment: datetime) -> date:
    return moment.date().replace(day=1)


def _next_month(month: date) -> datetime:
    return datetime(month.year + month.month // 12, month.month % 12 + 1, 1)


def _schedule(soup: BeautifulSoup, month: date) -> tuple[Schedule, Tag]:
    for strong in soup.find_all("strong"):
        match = _SCHEDULE.search(strong.get_text(" ", strip=True))
        if match:
            return Schedule(month, int(match.group(1)), int(match.group(2))), strong
    raise LayoutChanged("schedule: no 'Stacking Days / Battle Days' on the page")


def _winner(soup: BeautifulSoup) -> str | None:
    banner = soup.select_one("div.main-banner h1")
    match = _WINNER.fullmatch(banner.get_text(strip=True)) if banner else None
    return match.group(1) if match else None


def _tournament(schedule: Schedule, winner: str | None) -> pl.DataFrame:
    row = {
        "Month": schedule.month,
        "StackingDays": schedule.stacking_days,
        "BattleDays": schedule.battle_days,
        "EndsAtUtc": schedule.ends_at,
        "Winner": winner,
    }
    return pl.DataFrame([row], schema=ATLANTIS_TOURNAMENT_DTYPES)


def _rules(schedule_tag: Tag) -> list[str]:
    block = schedule_tag.parent.find_next_sibling("div")
    rules = [inset.get_text(" ", strip=True) for inset in block.find_all("div", class_="inset")]
    if len(rules) != 1 + _POSITIONS:
        raise LayoutChanged(f"rules: expected {1 + _POSITIONS} rules, got {len(rules)}")
    return rules


def _badges(link: Tag) -> tuple[bool, bool]:
    classes = [c for span in link.find_all("span") for c in span.get("class", [])]
    return "atlantis-gold" in classes, "gold-star" in classes


def _leaderboard(soup: BeautifulSoup, observed_at: datetime) -> list[dict[str, Any]]:
    heading = soup.find("h1", string=re.compile(r"Atlantis Leaderboard"))
    if heading is None:
        raise LayoutChanged("leaderboard: no 'Atlantis Leaderboard' heading")
    # `div.Swarm.inset` also appears elsewhere on the page (the zone's discoverer), so
    # everything is read from inside the leaderboard's own row.
    row = heading.find_parent("div", class_="row")

    rows: list[dict[str, Any]] = []

    def add(faction: str, link: Tag, score: str) -> None:
        tournament, weekly = _badges(link)
        rows.append(
            {
                "ObservedAtUtc": observed_at,
                "Faction": faction,
                "PlayerName": link.get_text(strip=True),
                "Launches": _number(score),
                "TournamentMillionKills": tournament,
                "WeeklyMillionKills": weekly,
            }
        )

    for podium in row.find_all("div", class_="inset"):
        faction = _faction_of(podium)
        if faction is None or not podium.find("div", class_=("one", "two", "three")):
            continue
        add(faction, podium.select_one("h3 a"), podium.find_all("h5")[-1].get_text(strip=True))

    for tr in row.find_all("tr"):
        faction = _faction_of(tr)
        if faction is None:
            continue
        cells = tr.find_all("td")
        add(faction, cells[2].find("a"), cells[3].get_text(strip=True))

    return rows


def _triangle_faction(names: list[str]) -> str | None:
    for name in names[len(names) - 3 :]:
        faction = _FORMATION_PREFIX.get(name[:2])
        if faction:
            return faction
    return None


def _zones(
    soup: BeautifulSoup, observed_at: datetime, month: date, rules: list[str]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    items = soup.select("div#carousel-example-generic div.item")
    if len(items) != _ZONE_COUNT:
        log.warning("atlantis: expected %d zones, found %d; writing none", _ZONE_COUNT, len(items))
        return [], []

    names = [item.select_one("h2.pull-left").get_text(strip=True) for item in items]
    keys = ["Prime"]
    for start in range(1, _ZONE_COUNT, _POSITIONS):
        faction = _triangle_faction(names[start : start + _POSITIONS])
        if faction is None:
            log.warning("atlantis: no faction letter on %s; writing no zones", names[start:])
            return [], []
        keys.extend(f"{faction} {position}" for position in range(1, _POSITIONS + 1))

    counts: list[dict[str, Any]] = []
    months: list[dict[str, Any]] = []
    for index, (item, name, key) in enumerate(zip(items, names, keys, strict=True)):
        counts.append(
            {
                "ObservedAtUtc": observed_at,
                "Zone": key,
                **{
                    f"{faction}Count": _number(
                        item.select_one(f"div.progress-{faction} strong").get_text(strip=True)
                    )
                    for faction in FACTIONS
                },
            }
        )
        rule = rules[0] if index == 0 else rules[(index - 1) % _POSITIONS + 1]
        months.append(
            {
                "Month": month,
                "Zone": key,
                "ZoneName": name,
                "CubesAllowed": _CUBES_ALLOWED in rule.lower(),
            }
        )
    return counts, months


def parse_page(html: str, observed_at: datetime) -> ParsedPage:
    """Turn the page into the four frames and the schedule.

    Raises `LayoutChanged` only when the schedule cannot be read: it decides `next_run_at`,
    so nothing can be recorded without it. The zones and the leaderboard fail independently,
    each logged and written as no rows, so one moved block does not discard the other.
    """
    soup = BeautifulSoup(html, features="lxml")
    month = _month_start(observed_at)

    with _section("schedule"):
        schedule, schedule_tag = _schedule(soup, month)

    counts: list[dict[str, Any]] = []
    months: list[dict[str, Any]] = []
    try:
        with _section("rules"):
            rules = _rules(schedule_tag)
        with _section("zones"):
            counts, months = _zones(soup, observed_at, month, rules)
    except LayoutChanged as exc:
        log.warning("atlantis: zones did not parse (%s); writing none", exc)

    leaderboard: list[dict[str, Any]] = []
    try:
        with _section("leaderboard"):
            leaderboard = _leaderboard(soup, observed_at)
    except LayoutChanged as exc:
        log.warning("atlantis: leaderboard did not parse (%s); writing none", exc)

    return ParsedPage(
        leaderboard=pl.DataFrame(leaderboard, schema=ATLANTIS_LEADERBOARD_DTYPES),
        zones=pl.DataFrame(counts, schema=ATLANTIS_ZONE_DTYPES),
        zone_months=pl.DataFrame(months, schema=ATLANTIS_ZONE_MONTH_DTYPES),
        tournament=_tournament(schedule, _winner(soup)),
        schedule=schedule,
    )


def parse_outcome(html: str, observed_at: datetime) -> pl.DataFrame:
    """The tournaments row alone: schedule and winner, from a page read after the end.

    The board and zone counts on that page are the final standings again, already held
    from the final pull, so only the row that can have gained a winner is worth writing.
    Raises `LayoutChanged` like `parse_page` when the schedule cannot be read.
    """
    soup = BeautifulSoup(html, features="lxml")
    with _section("schedule"):
        schedule, _ = _schedule(soup, _month_start(observed_at))
    return _tournament(schedule, _winner(soup))


# --- storage ----------------------------------------------------------------


def _root() -> Path:
    return config.RAW / "atlantis"


def _merge(
    incoming: pl.DataFrame, path: Path, key: tuple[str, ...], dtypes: dict[str, pl.DataType]
) -> int:
    """Fold rows into a parquet file on a key. Returns rows added.

    Keyed rather than appended, so a re-run over the same observation adds nothing; where
    a key already exists the incoming row wins.
    """
    before = 0
    if path.exists():
        current = pl.read_parquet(path)
        before = current.height
        # The file on disk may predate a widened dtype or a new column in `dtypes`, and the
        # hourly job restores it from R2 every run, so the contract is applied after the join.
        incoming = pl.concat([current, incoming], how="diagonal_relaxed")

    merged = (
        conform(incoming, dtypes)
        .unique(subset=list(key), keep="last", maintain_order=True)
        .sort(list(key))
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    merged.write_parquet(tmp, compression="zstd")
    tmp.replace(path)
    return merged.height - before


def _store(page: ParsedPage, observed_at: datetime) -> tuple[int, int]:
    """Merge the four frames. Returns leaderboard and zone rows added.

    Observations partition by year like the changelog. The month tables are tiny and are
    upserted whole every run, which is what makes a re-run a no-op.
    """
    root = _root()
    year = f"year={observed_at.year}"
    leaderboard = _merge(
        page.leaderboard,
        root / "leaderboard" / year / "rows.parquet",
        ATLANTIS_LEADERBOARD_KEY,
        ATLANTIS_LEADERBOARD_DTYPES,
    )
    zones = _merge(
        page.zones, root / "zones" / year / "rows.parquet", ATLANTIS_ZONE_KEY, ATLANTIS_ZONE_DTYPES
    )
    _merge(
        page.zone_months,
        root / "zone_months" / "rows.parquet",
        ATLANTIS_ZONE_MONTH_KEY,
        ATLANTIS_ZONE_MONTH_DTYPES,
    )
    _store_tournament(page.tournament)
    return leaderboard, zones


def _store_tournament(tournament: pl.DataFrame) -> None:
    _merge(
        tournament,
        _root() / "tournaments" / "rows.parquet",
        ATLANTIS_TOURNAMENT_KEY,
        ATLANTIS_TOURNAMENT_DTYPES,
    )


def _state_path() -> Path:
    return _root() / "state.json"


def _read_state() -> dict[str, Any]:
    path = _state_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        log.warning("%s is not JSON; starting from no state", path)
        return {}


def _stamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _write_state(state: dict[str, Any]) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def _observed_at(date_header: str | None) -> datetime:
    """The server's clock, not ours: a runner's clock is what the gate compares against."""
    if date_header:
        moment = parsedate_to_datetime(date_header).astimezone(UTC)
    else:
        moment = datetime.now(UTC)
    return moment.replace(tzinfo=None, microsecond=0)


# --- the run ----------------------------------------------------------------


def _record_outcome(html: str, observed_at: datetime, previous: dict[str, Any]) -> None:
    """A run after the final pull: keep the winner, discard the rest.

    The post-tournament board must not be recorded as part of the battle. The one thing
    that page has which the final pull did not is the banner naming the winner, so only
    the tournaments row is written.
    """
    month = _month_start(observed_at)
    log.info("atlantis: tournament for %s already finished", month)
    try:
        outcome = parse_outcome(html, observed_at)
    except LayoutChanged as exc:
        log.warning("atlantis: outcome did not parse (%s)", exc)
    else:
        _store_tournament(outcome)
        log.info("atlantis: %s winner: %s", month, outcome["Winner"][0])
    _write_state({**previous, "next_run_at": _stamp(_next_month(month))})


def scrape_atlantis() -> int:
    """Read the page once and fold it into the raw layer. Returns leaderboard rows added."""
    previous = _read_state()

    with _client() as client:
        response = client.get(ATLANTIS_URL)
        response.raise_for_status()
        observed_at = _observed_at(response.headers.get("Date"))
        html = response.text

    month = _month_start(observed_at)
    if previous.get("month") == month.isoformat() and previous.get("final_pull_done"):
        _record_outcome(html, observed_at, previous)
        return 0

    try:
        page = parse_page(html, observed_at)
    except LayoutChanged as exc:
        log.warning("atlantis: page did not parse (%s); trying again in an hour", exc)
        _write_state(
            {
                **previous,
                "next_run_at": _stamp(_next_hour(observed_at)),
                "observed_at": _stamp(observed_at),
            }
        )
        return 0

    added, zones_added = _store(page, observed_at)

    ends_at = page.schedule.ends_at
    final = observed_at >= ends_at
    next_run_at = _next_month(month) if final else _next_hour(observed_at)
    _write_state(
        {
            "month": month.isoformat(),
            "ends_at": _stamp(ends_at),
            "final_pull_done": final,
            "next_run_at": _stamp(next_run_at),
            "observed_at": _stamp(observed_at),
        }
    )
    log.info(
        "atlantis: %s: +%d leaderboard rows, +%d zone rows; ends %s, next run %s%s",
        observed_at,
        added,
        zones_added,
        _stamp(ends_at),
        _stamp(next_run_at),
        " (final pull)" if final else "",
    )
    return added
