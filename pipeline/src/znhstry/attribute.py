"""Attribute factions to Atlantis battle-report players.

Per (month, player): (a) the month's board where one exists, (b) an override
seed, (c) the report's own launch totals, (d) zone-name evidence (next month's
triangle), (e) the player's scraped faction. Months the backfill has not reached
stay Unconfirmed/'none'.

The last rung is the weakest, and the reason the third one exists. `Faction` on a
player row is the faction the portal rendered when it served the page, not the one
the player held on the day of the battle, so a report the backfill reached years
later answers today's question against an old battle. The header's per-faction
launch totals are stored with the battle instead, so where exactly one faction
launched they name the faction of everyone who did - the only per-battle faction
evidence the page preserves.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any

import polars as pl

from . import config
from .schema import ATLANTIS_PLAYER_FACTION_DTYPES, ATLANTIS_PLAYER_FACTION_KEY

log = logging.getLogger(__name__)

_FACTIONS = ("Legion", "Swarm", "Faceless")
_SEEDS_DIR = Path(__file__).resolve().parents[3] / "transform" / "seeds"


def _load_players(bs_path: Path, players_dir: Path) -> pl.DataFrame | None:
    if not bs_path.exists():
        return None
    bs = (
        pl.read_parquet(bs_path)
        .filter(pl.col("Country") == "Atlantis")
        .select(
            pl.col("Battle Report Number").alias("brn"),
            pl.col("Date").alias("d"),
            pl.col("Total Active Players").alias("hp"),
            *[pl.col(f"{f} Total Launches").alias(f"hl_{f}") for f in _FACTIONS],
        )
    )
    pq_files = list(players_dir.rglob("*.parquet")) if players_dir.exists() else []
    if not pq_files:
        return None
    players = pl.read_parquet(players_dir / "**/*.parquet", hive_partitioning=True)
    if players.height == 0:
        return None
    players = (
        players.rename({"BattleReportNumber": "brn"})
        .join(bs, on="brn", how="inner")
        .with_columns(pl.col("d").dt.truncate("1mo").alias("month"))
    )
    listed = players.group_by("brn").len().rename({"len": "listed"})
    bs = bs.join(listed, on="brn", how="inner").with_columns(
        (pl.col("listed") < pl.col("hp")).alias("truncated")
    )
    cols = ["brn", "truncated", *[f"hl_{f}" for f in _FACTIONS]]
    return players.join(bs.select(cols), on="brn", how="left")


def _load_board_evidence(
    lb_dir: Path,
) -> tuple[dict[tuple[date, str], str], set[tuple[date, str]]]:
    pq_files = list(lb_dir.rglob("*.parquet")) if lb_dir.exists() else []
    if not pq_files:
        return {}, set()
    lb = pl.read_parquet(lb_dir / "**/*.parquet", hive_partitioning=True)
    if lb.height == 0:
        return {}, set()
    lb = lb.with_columns(
        pl.col("ObservedAtUtc").dt.truncate("1mo").dt.date().alias("month")
    )
    grouped = (
        lb.group_by("month", "PlayerName")
        .agg(
            pl.col("Faction").n_unique().alias("nf"),
            pl.col("Faction").first().alias("board_fac"),
        )
    )
    board = grouped.filter(pl.col("nf") == 1)
    multi_board = grouped.filter(pl.col("nf") > 1)
    evidence = {
        (m, n): f
        for m, n, f in board.select("month", "PlayerName", "board_fac").iter_rows()
    }
    multi = {(m, n) for m, n in multi_board.select("month", "PlayerName").iter_rows()}
    return evidence, multi


def _load_zone_names(bs_path: Path) -> dict[tuple[date, str], str]:
    if not bs_path.exists():
        return {}
    bs = (
        pl.read_parquet(bs_path)
        .filter(pl.col("Country") == "Atlantis")
        .select(
            pl.col("Date").dt.truncate("1mo").alias("month"),
            pl.col("Zone Name").alias("zone_name"),
            pl.col("Region").alias("region"),
        )
    )
    tri = (
        bs.filter(pl.col("region") != "Central")
        .group_by("month", "zone_name")
        .agg(pl.col("region").first().alias("tri"))
    )
    return {(m, n): t for m, n, t in tri.iter_rows()}


def _zone_name_evidence(
    zone_names: dict[tuple[date, str], str],
    all_player_months: set[tuple[date, str]],
) -> dict[tuple[date, str], str]:
    evidence: dict[tuple[date, str], str] = {}
    for (m, zn), tri in zone_names.items():
        if tri in _FACTIONS:
            prev = date(m.year, m.month - 1, 1) if m.month > 1 else date(m.year - 1, 12, 1)
            if (prev, zn) in all_player_months:
                evidence[(prev, zn)] = tri
    return evidence


def _zone_name_mercs(bs_path: Path) -> set[tuple[date, str]]:
    if not bs_path.exists():
        return set()
    bs = (
        pl.read_parquet(bs_path)
        .filter(pl.col("Country") == "Atlantis")
        .filter(pl.col("Region") != "Central")
        .select(
            pl.col("Date").dt.truncate("1mo").alias("month"),
            pl.col("Zone Name").alias("zone_name"),
            pl.col("Region").alias("region"),
        )
    )
    multi = (
        bs.group_by("month", "zone_name")
        .agg(pl.col("region").n_unique().alias("n_tri"))
        .filter(pl.col("n_tri") > 1)
    )
    return {(m, n) for m, n in multi.select("month", "zone_name").iter_rows()}


def _report_totals_evidence(
    players: pl.DataFrame,
) -> tuple[dict[tuple[date, str], str], set[tuple[date, str]]]:
    """Faction from the report's own arithmetic, and who it says switched.

    A report whose header shows exactly one faction with launches was fought by that
    faction alone, so everyone who launched in it was of that faction. Those totals
    are stored with the battle rather than rendered from a profile, so unlike the
    row's own `Faction` they still mean in 2026 what they meant in 2014.

    `Launches > 0` is what makes the inference sound rather than merely true today:
    the page lists nobody who did not launch, and a defender appearing in a
    single-faction report would otherwise be read as one of the attackers.
    """
    launching = [pl.col(f"hl_{f}") > 0 for f in _FACTIONS]
    per_player = (
        players.filter(pl.col("Launches") > 0)
        .filter(pl.sum_horizontal([c.cast(pl.Int8) for c in launching]) == 1)
        .with_columns(
            pl.coalesce(
                [
                    pl.when(c).then(pl.lit(f))
                    for c, f in zip(launching, _FACTIONS, strict=True)
                ]
            ).alias("battle_faction")
        )
        .group_by("month", "PlayerName")
        .agg(
            pl.col("battle_faction").n_unique().alias("nf"),
            pl.col("battle_faction").first().alias("battle_faction"),
        )
    )
    evidence = {
        (m, n): f
        for m, n, f in per_player.filter(pl.col("nf") == 1)
        .select("month", "PlayerName", "battle_faction")
        .iter_rows()
    }
    multi = {
        (m, n)
        for m, n in per_player.filter(pl.col("nf") > 1)
        .select("month", "PlayerName")
        .iter_rows()
    }
    return evidence, multi


def _scraped_factions(players: pl.DataFrame) -> dict[tuple[date, str], str]:
    """The scraped faction per player-month, chosen rather than stumbled into.

    A month split across two scrape bands holds two of them. Keeping whichever row an
    unordered `unique()` yielded last made the answer differ between runs over the
    same data; the faction the player launched most under, ties broken by name, is at
    least the same answer twice.
    """
    picked = (
        players.group_by("month", "PlayerName", "Faction")
        .agg(pl.col("Launches").sum().alias("launches"))
        .sort(["launches", "Faction"], descending=[True, False])
        .group_by(["month", "PlayerName"], maintain_order=True)
        .first()
    )
    return {
        (m, n): f
        for m, n, f in picked.select("month", "PlayerName", "Faction").iter_rows()
    }


def _load_overrides() -> dict[tuple[date, str], str]:
    csv_path = _SEEDS_DIR / "atlantis_player_faction_overrides.csv"
    if not csv_path.exists():
        return {}
    df = pl.read_csv(csv_path, schema={
        "tournament_month": pl.Date, "player_name": pl.Utf8,
        "faction": pl.Utf8, "note": pl.Utf8,
    })
    return {
        (m, n): f
        for m, n, f in df.select("tournament_month", "player_name", "faction").iter_rows()
    }


def _detect_mercenary(
    results: list[dict[str, Any]],
    same_month: set[tuple[date, str]],
    zone_name_mercs: set[tuple[date, str]],
    confirmed: list[dict[tuple[date, str], str]],
) -> None:
    """Flag players who fought for more than one faction.

    Only evidence that was true of the battle counts, which rules the scraped
    faction out. The backfill walks report numbers a band a night, so a player who
    changed faction between two nights has their history split at that band, and
    reading the split as switching would flag the collection rather than the player.
    """
    factions: dict[str, set[str]] = defaultdict(set)
    for evidence in confirmed:
        for (_m, n), f in evidence.items():
            factions[n].add(f)

    for r in results:
        m, n = r["Month"], r["PlayerName"]
        parts: list[str] = []
        if (m, n) in same_month:
            parts.append("same-month")
        if (m, n) in zone_name_mercs:
            parts.append("zone-names")
        if len(factions.get(n, ())) > 1:
            parts.append("across-months")
        r["IsMercenary"] = bool(parts)
        r["MercenaryEvidence"] = ", ".join(parts) if parts else None


_REVIEW_SCHEMA = {
    "tournament_month": pl.Date, "player_name": pl.Utf8,
    "scraped_faction": pl.Utf8, "launches": pl.Int64,
    "reports": pl.Int64, "failing_reports": pl.Int64,
    "has_reconciling_report": pl.Boolean,
}


def _check_report(hdr: dict, by_brn: dict[int, list[dict[str, Any]]]) -> bool:
    sums: dict[str, int] = {f: 0 for f in _FACTIONS}
    for row in by_brn.get(hdr["brn"], []):
        sums[row["Faction"]] += row["Launches"]
    return all(sums[f] == hdr[f"hl_{f}"] for f in _FACTIONS)


def _review_month(
    month_val: date, month_players: pl.DataFrame, headers: pl.DataFrame,
) -> list[dict[str, Any]]:
    player_info: dict[str, dict[str, Any]] = {}
    for row in month_players.iter_rows(named=True):
        n = row["PlayerName"]
        if n not in player_info:
            player_info[n] = {
                "faction": row["Faction"], "launches": 0,
                "reports": set(), "failing": 0, "has_reconciling": False,
            }
        player_info[n]["launches"] += row["Launches"]
        player_info[n]["reports"].add(row["brn"])

    by_brn: dict[int, list[dict[str, Any]]] = {}
    for row in month_players.iter_rows(named=True):
        by_brn.setdefault(row["brn"], []).append(row)

    month_hdrs = headers.filter(pl.col("brn").is_in(list(month_players["brn"].unique())))
    for hdr in month_hdrs.iter_rows(named=True):
        ok = _check_report(hdr, by_brn)
        for _n, info in player_info.items():
            if hdr["brn"] not in info["reports"]:
                continue
            if ok:
                info["has_reconciling"] = True
            else:
                info["failing"] += 1

    return [
        {"tournament_month": month_val, "player_name": n,
         "scraped_faction": info["faction"], "launches": info["launches"],
         "reports": len(info["reports"]), "failing_reports": info["failing"],
         "has_reconciling_report": info["has_reconciling"]}
        for n, info in player_info.items()
        if info["failing"] > 0 and not info["has_reconciling"]
    ]


def _build_review_list(players: pl.DataFrame) -> pl.DataFrame:
    header_cols = ["brn", "truncated", *[f"hl_{f}" for f in _FACTIONS]]
    headers = players.select(header_cols).unique("brn").filter(~pl.col("truncated"))
    sel = players.select("brn", "PlayerName", "Faction", "Launches", "month")
    rows_by_report = sel.sort("brn", "PlayerName")

    review: list[dict[str, Any]] = []
    for (month_val,), mp in rows_by_report.group_by("month"):
        review.extend(_review_month(month_val, mp, headers))

    if not review:
        return pl.DataFrame(schema=_REVIEW_SCHEMA)
    return pl.DataFrame(review).sort("tournament_month", "player_name")


def attribute_factions() -> None:
    bs_path = config.RAW / "battlestats" / "battlestats.parquet"
    players_dir = config.RAW / "battlestats" / "players"
    lb_dir = config.RAW / "atlantis" / "leaderboard"
    out_path = config.RAW / "battlestats" / "player_factions" / "rows.parquet"
    review_path = config.RAW / "battlestats" / "player_factions" / "review.parquet"

    players = _load_players(bs_path, players_dir)
    if players is None or players.height == 0:
        log.info("attribute: no player rows available, nothing to do")
        _write_empty(out_path)
        _atomic_write_parquet(pl.DataFrame(schema=_REVIEW_SCHEMA), review_path)
        return

    board, board_multi = _load_board_evidence(lb_dir)
    zone_names = _load_zone_names(bs_path)
    zn_mercs = _zone_name_mercs(bs_path)
    overrides = _load_overrides()
    t0 = time.monotonic()

    scraped_map = _scraped_factions(players)
    all_player_months = set(scraped_map)

    rt_evidence, rt_multi = _report_totals_evidence(players)
    zn_evidence = _zone_name_evidence(zone_names, all_player_months)

    results: list[dict[str, Any]] = []
    for (m, n), scraped in sorted(scraped_map.items()):
        bf = board.get((m, n))
        ov = overrides.get((m, n))
        rt = rt_evidence.get((m, n))
        zn = zn_evidence.get((m, n))
        if bf is not None:
            faction, source = bf, "board"
        elif ov is not None:
            faction, source = ov, "override"
        elif rt is not None:
            faction, source = rt, "report-totals"
        elif zn is not None:
            faction, source = zn, "zone-name"
        else:
            faction, source = scraped, "scraped"
        results.append({
            "Month": m, "PlayerName": n, "Faction": faction,
            "FactionSource": source, "IsMercenary": False,
            "MercenaryEvidence": None,
        })

    _detect_mercenary(
        results, board_multi | rt_multi, zn_mercs, [board, zn_evidence, rt_evidence]
    )

    review_df = _build_review_list(players)
    _atomic_write_parquet(review_df, review_path)

    _write_results(results, out_path)
    log.info(
        "attribute: %d player-months in %.1f s, %d review rows",
        len(results), time.monotonic() - t0, review_df.height,
    )


def _atomic_write_parquet(df: pl.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    df.write_parquet(tmp, compression="zstd")
    tmp.replace(path)


def _write_results(results: list[dict[str, Any]], path: Path) -> None:
    df = pl.DataFrame(results, schema=ATLANTIS_PLAYER_FACTION_DTYPES)
    df = df.unique(subset=list(ATLANTIS_PLAYER_FACTION_KEY), keep="last").sort(
        list(ATLANTIS_PLAYER_FACTION_KEY)
    )
    _atomic_write_parquet(df, path)


def _write_empty(path: Path) -> None:
    _atomic_write_parquet(
        pl.DataFrame(schema=ATLANTIS_PLAYER_FACTION_DTYPES), path
    )
