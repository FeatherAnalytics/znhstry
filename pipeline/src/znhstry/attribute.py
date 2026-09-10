"""Attribute factions to Atlantis battle-report players.

Reads the per-player rows (from the backfill) and the battlestats header,
runs a greedy reconciliation per month, overlays board and zone-name evidence,
and writes one row per (month, player) to player_factions/rows.parquet.

The algorithm is ported from the spike's month_solve.py, tested against 16
archived boards at 100% confirmed agreement and 99.8% reconciled.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from datetime import date
from itertools import combinations
from pathlib import Path
from typing import Any

import polars as pl

from . import config
from .schema import ATLANTIS_PLAYER_FACTION_DTYPES, ATLANTIS_PLAYER_FACTION_KEY

log = logging.getLogger(__name__)

_FACTIONS = ("Legion", "Swarm", "Faceless")


class _Month:
    """Per-month greedy faction solver."""

    def __init__(
        self,
        month: date,
        rows: list[tuple[int, str, str, int]],
        reports: dict[int, dict[str, Any]],
    ) -> None:
        self.month = month
        self.rows = rows
        self.scraped: dict[str, str] = {}
        self.by_player: dict[str, list[tuple[int, int]]] = defaultdict(list)
        self.by_report: dict[int, list[tuple[str, int]]] = defaultdict(list)
        for b, n, s, launches in rows:
            self.scraped[n] = s
            self.by_player[n].append((b, launches))
            self.by_report[b].append((n, launches))
        self.header = {
            b: {f: h[f] for f in _FACTIONS}
            for b, h in reports.items()
            if not h["truncated"]
        }
        self.assign = dict(self.scraped)
        self.moved: set[str] = set()
        self.sums: dict[int, dict[str, int]] = {}
        for b in self.header:
            self.sums[b] = {f: 0 for f in _FACTIONS}
            for n, launches in self.by_report[b]:
                self.sums[b][self.assign[n]] += launches

    def _ok(self, b: int) -> bool:
        return self.sums[b] == self.header[b]

    def score(self) -> int:
        return sum(self._ok(b) for b in self.header)

    def _apply(self, name: str, g: str) -> None:
        a = self.assign[name]
        if a == g:
            return
        for b, launches in self.by_player[name]:
            if b in self.header:
                self.sums[b][a] -= launches
                self.sums[b][g] += launches
        self.assign[name] = g

    def _gain(self, moves: list[tuple[str, str]]) -> int:
        touched = set()
        for n, _ in moves:
            touched.update(b for b, _ in self.by_player[n] if b in self.header)
        before = sum(self._ok(b) for b in touched)
        saved = [(n, self.assign[n]) for n, _ in moves]
        for n, g in moves:
            self._apply(n, g)
        after = sum(self._ok(b) for b in touched)
        for n, a in saved:
            self._apply(n, a)
        return after - before

    def _candidates_single(self):
        names: set[str] = set()
        for b in self.header:
            if not self._ok(b):
                names.update(n for n, _ in self.by_report[b])
        for n in sorted(names, key=lambda x: (-sum(v for _, v in self.by_player[x]), x)):
            for g in _FACTIONS:
                if g != self.assign[n]:
                    yield [(n, g)]

    def _candidates_pair(self, b: int):
        rows = self.by_report[b]
        for (ni, _), (nj, _) in combinations(rows, 2):
            for gi in _FACTIONS:
                if gi == self.assign[ni]:
                    continue
                for gj in _FACTIONS:
                    if gj == self.assign[nj]:
                        continue
                    yield [(ni, gi), (nj, gj)]

    def _best(self, cands):
        best, best_gain = None, 0
        for mv in cands:
            g = self._gain(mv)
            if g > best_gain:
                best, best_gain = mv, g
        return best

    def _commit(self, mv: list[tuple[str, str]]) -> None:
        for n, f in mv:
            self._apply(n, f)
            self.moved.add(n)

    def solve(self) -> None:
        while True:
            mv = self._best(self._candidates_single())
            if mv is None:
                break
            self._commit(mv)
        progressed = True
        while progressed:
            progressed = False
            for b in sorted(self.header):
                if self._ok(b) or len(self.by_report[b]) > 50:
                    continue
                mv = self._best(self._candidates_pair(b))
                if mv is not None:
                    self._commit(mv)
                    progressed = True

    def _unique_for(self, name: str) -> bool:
        return all(
            self._gain([(name, g)]) < 0
            for g in _FACTIONS
            if g != self.assign[name]
        )

    def label(self, name: str) -> tuple[str, str | None]:
        untr = [b for b, _ in self.by_player[name] if b in self.header]
        if not untr:
            return "none", None
        if not any(self._ok(b) for b in untr):
            return "none", None
        if not self._unique_for(name):
            return "none", None
        source = "reconciled" if name in self.moved else "confirmed"
        return source, self.assign[name]


def _load_players(bs_path: Path, players_dir: Path) -> pl.DataFrame | None:
    """Load per-player rows, preferring the backfill table over the packed string."""
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


def _load_board_evidence(lb_dir: Path) -> tuple[dict[tuple[date, str], str], set[tuple[date, str]]]:
    """Board evidence: (month, player) -> faction where ALL observations agree.

    Also returns (month, player) pairs that appeared under 2+ factions on the
    board in the same month (same-month mercenary evidence).
    """
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
    """Zone name -> triangle (Region) per month, for zone-name evidence."""
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
    player_months: dict[tuple[date, str], str],
) -> dict[tuple[date, str], str]:
    """If a player is named as a zone in a faction's triangle, that's their faction."""
    evidence: dict[tuple[date, str], str] = {}
    for (m, zn), tri in zone_names.items():
        if tri in _FACTIONS:
            prev = date(m.year, m.month - 1, 1) if m.month > 1 else date(m.year - 1, 12, 1)
            if (prev, zn) in player_months:
                evidence[(prev, zn)] = tri
    return evidence


def _zone_name_mercs(bs_path: Path) -> set[tuple[date, str]]:
    """Players whose name appears in 2+ different triangles in one month."""
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


def _across_month_mercs(results: list[dict[str, Any]]) -> set[str]:
    """Players with 2+ non-Unconfirmed factions in any months of the record."""
    by_player: dict[str, set[str]] = defaultdict(set)
    for r in results:
        if r["Faction"] != "Unconfirmed":
            by_player[r["PlayerName"]].add(r["Faction"])
    return {n for n, factions in by_player.items() if len(factions) > 1}


def _detect_mercenary(
    results: list[dict[str, Any]],
    board_multi: set[tuple[date, str]],
    zone_name_mercs: set[tuple[date, str]],
) -> None:
    """Set is_mercenary and mercenary_evidence on result rows."""
    across = _across_month_mercs(results)
    for r in results:
        m, n, f = r["Month"], r["PlayerName"], r["Faction"]
        parts: list[str] = []
        if (m, n) in board_multi:
            parts.append("same-month")
        if (m, n) in zone_name_mercs:
            parts.append("zone-names")
        if n in across and f != "Unconfirmed":
            parts.append("across-months")
        r["IsMercenary"] = bool(parts)
        r["MercenaryEvidence"] = ", ".join(parts) if parts else None


def _solve_month(
    month_val: date,
    sub: pl.DataFrame,
    board: dict[tuple[date, str], str],
) -> list[dict[str, Any]]:
    reps: dict[int, dict[str, Any]] = {}
    cols = ["brn", "truncated", *[f"hl_{f}" for f in _FACTIONS]]
    for row in sub.select(cols).unique("brn").iter_rows(named=True):
        reps[row["brn"]] = {
            **{f: row[f"hl_{f}"] for f in _FACTIONS},
            "truncated": row["truncated"],
        }
    rows = list(sub.select("brn", "PlayerName", "Faction", "Launches").iter_rows())
    M = _Month(month_val, rows, reps)
    s0 = M.score()
    M.solve()
    s1 = M.score()

    results: list[dict[str, Any]] = []
    for name in M.scraped:
        source, faction = M.label(name)
        faction = faction if faction is not None else "Unconfirmed"
        bf = board.get((month_val, name))
        if bf is not None:
            faction, source = bf, "board"
        results.append({
            "Month": month_val,
            "PlayerName": name,
            "Faction": faction,
            "FactionSource": source,
            "IsMercenary": False,
            "MercenaryEvidence": None,
        })

    log.info(
        "attribute: %s  %d->%d/%d reconciled  %d players  %d moved",
        month_val, s0, s1, len(M.header), len(M.scraped), len(M.moved),
    )
    return results


def attribute_factions() -> None:
    """Run the faction attribution and write the output."""
    bs_path = config.RAW / "battlestats" / "battlestats.parquet"
    players_dir = config.RAW / "battlestats" / "players"
    lb_dir = config.RAW / "atlantis" / "leaderboard"
    out_path = config.RAW / "battlestats" / "player_factions" / "rows.parquet"

    players = _load_players(bs_path, players_dir)
    if players is None or players.height == 0:
        log.info("attribute: no player rows available, nothing to do")
        _write_empty(out_path)
        return

    board, board_multi = _load_board_evidence(lb_dir)
    zone_names = _load_zone_names(bs_path)
    zn_mercs = _zone_name_mercs(bs_path)
    t0 = time.monotonic()

    results: list[dict[str, Any]] = []
    for (month_val,), sub in players.group_by("month"):
        results.extend(_solve_month(month_val, sub, board))

    zn_evidence = _zone_name_evidence(
        zone_names, {(r["Month"], r["PlayerName"]): r["Faction"] for r in results}
    )
    for r in results:
        zn = zn_evidence.get((r["Month"], r["PlayerName"]))
        if zn is not None and r["FactionSource"] == "none":
            r["Faction"] = zn
            r["FactionSource"] = "zone-name"

    _detect_mercenary(results, board_multi, zn_mercs)
    _write_results(results, out_path)
    log.info(
        "attribute: %d player-months in %.1f s",
        len(results), time.monotonic() - t0,
    )


def _write_results(results: list[dict[str, Any]], path: Path) -> None:
    df = pl.DataFrame(results, schema=ATLANTIS_PLAYER_FACTION_DTYPES)
    df = df.unique(subset=list(ATLANTIS_PLAYER_FACTION_KEY), keep="last").sort(
        list(ATLANTIS_PLAYER_FACTION_KEY)
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    df.write_parquet(tmp, compression="zstd")
    tmp.replace(path)


def _write_empty(path: Path) -> None:
    """Write an empty file with the contract schema so dbt's glob matches."""
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(schema=ATLANTIS_PLAYER_FACTION_DTYPES).write_parquet(
        path, compression="zstd"
    )
