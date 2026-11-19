"""Collect player profiles from QONQR's portal: level, faction, status, rank and medals.

`portal.qonqr.com/Player/Details/<name>` is login-only, so this is the one collector that
signs in, as the account in `QONQR_USERNAME` / `QONQR_PASSWORD`. Names come from every
player we have already seen - battle reports, the Atlantis leaderboard, and a one-time
seed from the portal's leaderboards - and the set grows as those do, so the table is
built up over many runs rather than in one crawl. `_targets` decides who is fetched.

One row per player per fetch, with a boolean column per medal. The medal list is fixed by
the game; a page naming one not in `MEDALS` fails the run rather than dropping it.

Each fetch is a snapshot stamped with `scraped_at`, never an overwrite: faction and level
are only true at the moment they were read, and a player who switches faction is exactly
the history worth keeping.

## The portal's error page

The portal answers a transient fault *and* a player that does not exist the same way: a
redirect to `/500.html` with status 200. The developer's own advice for the first is to
go back and try again, so a 500 is retried; one that survives every retry is recorded as
not found and asked for again in the oldest-first rotation, since a renamed player and a
flaky server are indistinguishable from here.

Politeness rules are the battle-report ones: serial, a floor between requests, and a cap
per run.
"""

from __future__ import annotations

import logging
import os
import re
import time
from datetime import UTC, datetime, timedelta
from urllib.parse import unquote

import duckdb
import httpx
import polars as pl
from bs4 import BeautifulSoup

from . import config

log = logging.getLogger(__name__)

BASE = "https://portal.qonqr.com"
LOGIN_PATH = "/Home/Login"
PROFILE_PATH = "/Player/Details/{name}"
ERROR_PATH = "/500.html"
LEADERBOARD_PATH = "/Leaderboard"
LEADERBOARDS = ["", "/BotKills", "/Captures", "/ZoneLeads", "/Harvest", "/Recruit", "/Ordnance"]

PATH = config.RAW / "players" / "profiles.parquet"
# Outside data/raw so the archive never ships it; it only lets a stopped seed resume.
SEED_DONE_PATH = config.DATA / "leaderboard_seed_done.txt"
# A country leaderboard lists at most this many players.
COUNTRY_PAGE_CAP = 50
# A by-hand run names its players; the cap keeps a pasted list from becoming a crawl.
MAX_NAMED = 50
_NAME = re.compile(r"[A-Za-z0-9_.\-]{1,40}")

# Page name -> column, in the order the page lists them.
MEDALS = {
    "Complete Bootcamp": "complete_bootcamp",
    "Complete Training": "complete_training",
    "Combatant": "combatant",
    "Warrior": "warrior",
    "Exterminator": "exterminator",
    "Annihilator": "annihilator",
    "Mega Annihilator": "mega_annihilator",
    "Recruiter": "recruiter",
    "Promoter": "promoter",
    "Leader": "leader",
    "Champion": "champion",
    "Super Recruiter": "super_recruiter",
    "Collector": "collector",
    "Gatherer": "gatherer",
    "Producer": "producer",
    "Industrialist": "industrialist",
    "Monopolist": "monopolist",
    "Boy Scout": "boy_scout",
    "Journeyman": "journeyman",
    "Outfitter": "outfitter",
    "Commando": "commando",
    "Opportunist": "opportunist",
    "Planner": "planner",
    "Exploiter": "exploiter",
    "Specialist": "specialist",
    "Uber Specialist": "uber_specialist",
    "Challenger": "challenger",
    "Vanquisher": "vanquisher",
    "Liberator": "liberator",
    "QONQRER": "qonqrer",
    "Ultra QONQRer": "ultra_qonqrer",
    "Discover Atlantis": "discover_atlantis",
    "1st in Atlantis": "first_in_atlantis",
    "2nd in Atlantis": "second_in_atlantis",
    "3rd in Atlantis": "third_in_atlantis",
}

SCHEMA = {
    "player_name": pl.String,
    "scraped_at": pl.Datetime("us"),
    "found": pl.Boolean,
    "display_name": pl.String,
    "level": pl.Int32,
    "faction": pl.String,
    "status": pl.String,
    "rank_points": pl.Int32,
    "current_rank": pl.String,
    "current_rank_achieved_on": pl.Date,
    "start_date": pl.Date,
    **{column: pl.Boolean for column in MEDALS.values()},
}
KEY = ["player_name", "scraped_at"]

# US month-first, as everywhere on the portal: "10/3/2015" is 3 October.
_DATE_FORMAT = "%m/%d/%Y"


class SessionExpired(Exception):
    """The portal bounced a request to the login page."""


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=BASE,
        timeout=config.PORTAL_TIMEOUT,
        follow_redirects=True,
        headers={"User-Agent": config.USER_AGENT},
    )


def login(client: httpx.Client) -> None:
    username = os.environ.get("QONQR_USERNAME")
    password = os.environ.get("QONQR_PASSWORD")
    if not username or not password:
        raise SystemExit("QONQR_USERNAME and QONQR_PASSWORD must be set (root .env or secrets).")
    form = BeautifulSoup(client.get(LOGIN_PATH).text, "html.parser")
    token = form.find("input", {"name": "__RequestVerificationToken"})
    if token is None:
        raise RuntimeError("login page has no anti-forgery token; the form has changed")
    time.sleep(config.PORTAL_MIN_INTERVAL)
    # The post often lands on /500.html even when the sign-in worked, so success is
    # judged by the first profile fetch not bouncing to the login page, not by this.
    client.post(
        LOGIN_PATH,
        data={
            "Username": username,
            "Password": password,
            "ReturnUrl": "/",
            "__RequestVerificationToken": token["value"],
        },
    )


def fetch_profile(client: httpx.Client, name: str) -> str | None:
    return _fetch_page(client, PROFILE_PATH.format(name=name))


def _fetch_page(client: httpx.Client, path: str) -> str | None:
    """The page's HTML, or None when every retry ended on the error page."""
    for attempt in range(config.PROFILE_RETRIES):
        if attempt:
            time.sleep(config.PROFILE_INTERVAL)
        response = _get(client, path)
        landed = response.url.path
        if landed.startswith(LOGIN_PATH):
            raise SessionExpired(path)
        if landed != ERROR_PATH:
            response.raise_for_status()
            return response.text
    return None


def _get(client: httpx.Client, path: str) -> httpx.Response:
    """One retry after a long pause on a dropped connection; a second drop ends the run.

    A reset from the game's own server may be it pushing back, so the answer is to back
    off and then stop, never to hammer.
    """
    try:
        return client.get(path)
    except httpx.TransportError as error:
        log.warning("profiles: %s on %s; waiting %ss", error, path, config.PROFILE_BACKOFF)
        time.sleep(config.PROFILE_BACKOFF)
        return client.get(path)


def _int(text: str) -> int:
    return int(re.sub(r"[^\d-]", "", text))


def _parse_card(soup: BeautifulSoup, name: str) -> dict:
    card = soup.select_one(".page-content .col-xs-7")
    if card is None:
        raise ValueError(f"{name}: no profile card; the page layout has changed")
    headings = [h.get_text(" ", strip=True) for h in card.find_all("h3")]
    level_at = next(i for i, text in enumerate(headings) if text.startswith("Level "))
    status = card.find("div").find(string=True, recursive=False)
    medal_heading = next(
        h for h in soup.find_all("h1") if h.get_text(strip=True).startswith("Medals")
    )
    return {
        "display_name": card.find("h2").get_text(strip=True),
        "level": _int(headings[level_at]),
        "faction": headings[level_at + 1],
        "status": status.strip(),
        "rank_points": _int(medal_heading.find("small").get_text()),
    }


def _parse_medals(soup: BeautifulSoup, name: str) -> dict[str, bool]:
    earned = {item.find("h3").get_text(strip=True) for item in soup.select("li.list-group-item")}
    unknown = earned - MEDALS.keys()
    if unknown:
        raise ValueError(f"{name}: medals not in MEDALS: {sorted(unknown)}")
    return {column: medal in earned for medal, column in MEDALS.items()}


def _parse_rank(soup: BeautifulSoup) -> dict:
    """The highest tier with a date, and when the first tier (Private) was reached.

    The page lists every tier, reached or not. Every player starts at Private, so its
    date stands in for when the account started.
    """
    reached = []
    for block in soup.select(".media"):
        title = block.find("h1")
        achieved = title.find("small").get_text(strip=True)
        if achieved:
            name = title.find(string=True, recursive=False).strip()
            reached.append((name, datetime.strptime(achieved, _DATE_FORMAT).date()))
    current = reached[-1] if reached else (None, None)
    return {
        "current_rank": current[0],
        "current_rank_achieved_on": current[1],
        "start_date": reached[0][1] if reached else None,
    }


def parse_profile(html: str, name: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    return {
        "player_name": name,
        "found": True,
        **_parse_card(soup, name),
        **_parse_rank(soup),
        **_parse_medals(soup, name),
    }


def _targets(now: datetime, limit: int, new_only: bool = False) -> list[str]:
    """Today's fetch list, in priority order.

    1. Never fetched, most recently seen first.
    2. Seen in a battle report or on the Atlantis board after their last fetch while
       their stored status was not Active - they launched, so the status is stale.
    3. Status differed between their last two fetches, re-checked after a week.
    4. Everyone else, Retired included, oldest fetch first.

    Fallen players ("reported as deceased") are never fetched again. `new_only` keeps
    priority 1 alone, for a catch-up that must not spend requests on refreshes.

    Status itself is only ever the portal's. Sightings are a trigger to look, never a
    substitute: most launches happen in zones no battle report covers.
    """
    battle = (config.RAW / "battlestats" / "players" / "**" / "*.parquet").as_posix()
    atlantis = (config.RAW / "atlantis" / "leaderboard" / "**" / "*.parquet").as_posix()
    reports = (config.RAW / "battlestats" / "battlestats.parquet").as_posix()
    recheck = now - timedelta(days=config.PROFILE_RECHECK_DAYS)
    rows = duckdb.sql(f"""
        with seen as (
            select PlayerName as name, BattleDate as seen_on
            from read_parquet('{battle}', union_by_name = true)
            union all
            -- Every report's own player list (groups of five, name second). The rows
            -- above are mostly tournament reports; without this, regular ones go unseen.
            select unnest(list_filter(string_split(players, ','), (x, i) -> i % 5 = 2)), "Date"
            from '{reports}'
            where players is not null
            union all
            select PlayerName, cast(ObservedAtUtc as date)
            from read_parquet('{atlantis}', union_by_name = true)
            union all
            select player_name, null from '{PATH.as_posix()}'
        ),
        names as (
            select lower(name) as k, min(name) as name, max(seen_on) as last_seen
            from seen
            where trim(name) <> ''
            group by 1
        ),
        fetches as (
            select
                lower(player_name) as k,
                scraped_at,
                status,
                lag(status) over by_player as prev_status,
                count(*) over by_player
                    - row_number() over by_player + 1 as nth
            from '{PATH.as_posix()}'
            window by_player as (partition by lower(player_name) order by scraped_at)
        ),
        latest as (select * from fetches where nth = 1),
        ranked as (
            select
                n.name,
                n.last_seen,
                l.scraped_at,
                case
                    when l.k is null then 1
                    when l.status = 'Fallen' then null
                    when l.status <> 'Active' and n.last_seen > cast(l.scraped_at as date) then 2
                    when l.prev_status is distinct from l.status and l.prev_status is not null
                        and l.scraped_at <= $recheck then 3
                    else 4
                end as priority
            from names n
            left join latest l using (k)
        )
        select name
        from ranked
        where priority is not null and (not $new_only or priority = 1)
        order by priority, if(priority <= 2, last_seen, null) desc nulls last, scraped_at, name
        limit $limit
    """, params={"recheck": recheck, "limit": limit, "new_only": new_only}).fetchall()
    return [row[0] for row in rows]


def _merge(rows: list[dict]) -> None:
    incoming = pl.DataFrame(rows, schema=SCHEMA)
    # Diagonal: rows written before a column existed get it as null.
    merged = (
        pl.concat([pl.read_parquet(PATH), incoming], how="diagonal_relaxed")
        .select(list(SCHEMA))
        .unique(subset=KEY, keep="last")
        .sort(KEY)
    )
    tmp = PATH.with_name(PATH.name + ".tmp")
    merged.write_parquet(tmp, compression="zstd")
    tmp.replace(PATH)


def ensure_tables() -> None:
    """An empty file, so dbt's source and the target query resolve before any scrape."""
    if not PATH.exists():
        PATH.parent.mkdir(parents=True, exist_ok=True)
        pl.DataFrame(schema=SCHEMA).write_parquet(PATH, compression="zstd")


def _player_links(html: str) -> set[str]:
    soup = BeautifulSoup(html, "html.parser")
    return {
        unquote(a["href"].removeprefix(PROFILE_PATH.format(name="")))
        for a in soup.select(f'a[href^="{PROFILE_PATH.format(name="")}"]')
    }


def _lookup(query: str) -> list[tuple]:
    lookups = (config.RAW / "lookups").as_posix()
    return duckdb.sql(query.replace("{lookups}", lookups)).fetchall()


class _Seed:
    """Resumable state of the one-time name seed: finished pages and full countries."""

    def __init__(self) -> None:
        exists = SEED_DONE_PATH.exists()
        lines = SEED_DONE_PATH.read_text(encoding="utf-8").split() if exists else []
        self.done = {line for line in lines if not line.startswith("full:")}
        self.full = {int(line[5:]) for line in lines if line.startswith("full:")}

    def save(self) -> None:
        lines = sorted(self.done) + [f"full:{c}" for c in sorted(self.full)]
        tmp = SEED_DONE_PATH.with_name(SEED_DONE_PATH.name + ".tmp")
        tmp.write_text("\n".join(lines), encoding="utf-8")
        tmp.replace(SEED_DONE_PATH)


def _known() -> set[str]:
    return set(pl.read_parquet(PATH, columns=["player_name"])["player_name"].str.to_lowercase())


def _seed_page(client: httpx.Client, seed: _Seed, page: str, country: int | None) -> int:
    """Read one leaderboard page, fetch each player not in the table yet, then mark it done."""
    time.sleep(config.PROFILE_INTERVAL)
    names = _player_links(_fetch_page(client, page) or "")
    if country is not None and len(names) >= COUNTRY_PAGE_CAP:
        seed.full.add(country)
    fetched = _fetch_new(client, names)
    seed.done.add(page)
    seed.save()
    return fetched


def seed_names() -> int:
    """One-time: find every player on the portal's leaderboards and fetch the new ones.

    Reads the seven boards and every country page. A country page lists at most
    COUNTRY_PAGE_CAP players, so only a country showing that many can have players the
    page leaves out, and only those countries' region pages are read. Each player not
    already in the profile table is fetched on the spot. Only names are read from the
    leaderboards; their numbers sit behind decoy columns and are not collected.
    Resumable: finished pages are recorded in SEED_DONE_PATH.
    """
    ensure_tables()
    seed = _Seed()
    fetched = 0
    with _client() as client:
        login(client)
        countries = _lookup("select countryid from '{lookups}/countries.parquet' order by 1")
        pages = [(LEADERBOARD_PATH + b, None) for b in LEADERBOARDS]
        pages += [(f"{LEADERBOARD_PATH}/Country/{c}", c) for (c,) in countries]
        fetched += _seed_pages(client, seed, pages)
        regions = _lookup(
            "select regionid, countryid from '{lookups}/regions.parquet' order by 2, 1"
        )
        region_pages = [
            (f"{LEADERBOARD_PATH}/Region/{r}?CountryId={c}", None)
            for r, c in regions
            if c in seed.full
        ]
        log.info("seed: %d full countries, %d region pages", len(seed.full), len(region_pages))
        fetched += _seed_pages(client, seed, region_pages)
    return fetched


def _seed_pages(client: httpx.Client, seed: _Seed, pages: list[tuple[str, int | None]]) -> int:
    todo = [(page, country) for page, country in pages if page not in seed.done]
    fetched = 0
    for i, (page, country) in enumerate(todo, 1):
        fetched += _seed_page(client, seed, page, country)
        if i % config.PROFILE_FLUSH_EVERY == 0 or i == len(todo):
            log.info("seed: %d/%d pages, %d new profiles so far", i, len(todo), fetched)
    return fetched


def _fetch_new(client: httpx.Client, names: list[str]) -> int:
    known = _known()
    new = sorted({n.lower(): n for n in names if n.lower() not in known}.values())
    if new:
        seconds = len(new) * config.PROFILE_INTERVAL
        log.info("seed: %d new players, fetching (~%d s)", len(new), seconds)
    rows = []
    for name in new:
        time.sleep(config.PROFILE_INTERVAL)
        rows.append(_collect(client, name))
    if rows:
        _merge(rows)
    return len(rows)


def named_targets(text: str) -> list[str]:
    """Comma-separated player names from a person, checked before any request is made."""
    names = list({n.lower(): n for n in (part.strip() for part in text.split(",")) if n}.values())
    bad = [n for n in names if not _NAME.fullmatch(n)]
    if bad:
        raise SystemExit(f"not a player name: {', '.join(bad)}")
    if len(names) > MAX_NAMED:
        raise SystemExit(f"{len(names)} names; at most {MAX_NAMED} per run")
    return names


def scrape_profiles(
    limit: int | None = None, names: str | None = None, new_only: bool = False
) -> int:
    ensure_tables()
    now = datetime.now(UTC).replace(tzinfo=None, microsecond=0)
    if names:
        targets = named_targets(names)
    elif new_only:
        # Every never-fetched name unless --limit says otherwise; the per-run cap is for refreshes.
        targets = _targets(now, limit or 1_000_000, new_only=True)
    else:
        targets = _targets(now, limit or config.PROFILES_MAX_PER_RUN)
    log.info("profiles: %d due this run", len(targets))
    rows: list[dict] = []
    found = 0
    with _client() as client:
        if targets:
            login(client)
        try:
            for i, name in enumerate(targets, 1):
                time.sleep(config.PROFILE_INTERVAL)
                row = _collect(client, name)
                rows.append(row)
                found += row["found"]
                if i % config.PROFILE_FLUSH_EVERY == 0 or i == len(targets):
                    _merge(rows)
                    rows.clear()
                    log.info("profiles: %d/%d fetched, %d found", i, len(targets), found)
        finally:
            if rows:
                _merge(rows)
    return found


def _collect(client: httpx.Client, name: str) -> dict:
    scraped_at = datetime.now(UTC).replace(tzinfo=None, microsecond=0)
    try:
        html = fetch_profile(client, name)
    except SessionExpired:
        log.warning("profiles: session expired at %s; signing in again", name)
        login(client)
        html = fetch_profile(client, name)
    if html is None:
        return {"player_name": name, "scraped_at": scraped_at, "found": False}
    return {**parse_profile(html, name), "scraped_at": scraped_at}
