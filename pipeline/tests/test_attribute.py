"""Faction attribution, where the evidence is worth more than the label.

`Faction` on a battle-report player row is the faction the portal rendered when it
served the page, so the backfill stamps years-old battles with today's answer. The
report's own launch totals are stored with the battle and do not move, which is why
they outrank it. These pin that order and the two ways it used to go wrong: an
arbitrary pick between two scrape bands, and reading the split between those bands
as a player switching sides.
"""

from __future__ import annotations

from datetime import date

import polars as pl

from znhstry.attribute import (
    _detect_mercenary,
    _report_totals_evidence,
    _scraped_factions,
)

JAN = date(2018, 1, 1)
FEB = date(2018, 2, 1)


def _players(*rows: dict) -> pl.DataFrame:
    """A players frame shaped like the one `_load_players` hands over."""
    return pl.DataFrame(
        [
            {
                "month": JAN,
                "PlayerName": "ann",
                "Faction": "Swarm",
                "Launches": 10,
                "hl_Legion": 0,
                "hl_Swarm": 10,
                "hl_Faceless": 0,
            }
            | row
            for row in rows
        ]
    )


def test_one_faction_launching_names_everyone_who_launched():
    """The header totals are the battle's own numbers, unlike the row's faction."""
    evidence, multi = _report_totals_evidence(
        _players({"Faction": "Legion", "hl_Legion": 0, "hl_Swarm": 40, "hl_Faceless": 0})
    )
    assert evidence == {(JAN, "ann"): "Swarm"}
    assert multi == set()


def test_a_report_two_factions_fought_proves_nothing():
    """Which of them the player launched for is exactly what the page does not say."""
    evidence, multi = _report_totals_evidence(
        _players({"hl_Legion": 5, "hl_Swarm": 40, "hl_Faceless": 0})
    )
    assert evidence == {}
    assert multi == set()


def test_two_factions_in_one_month_is_evidence_of_switching_not_of_a_faction():
    """Both readings are true of a different battle, so neither is true of the month."""
    evidence, multi = _report_totals_evidence(
        _players(
            {"hl_Legion": 0, "hl_Swarm": 40, "hl_Faceless": 0},
            {"hl_Legion": 30, "hl_Swarm": 0, "hl_Faceless": 0},
        )
    )
    assert evidence == {}
    assert multi == {(JAN, "ann")}


def test_a_player_who_did_not_launch_is_not_one_of_the_attackers():
    """The page lists nobody with no launches today, and the inference rests on that.

    A defender listed in a report only one faction launched in would otherwise be
    read as a member of it.
    """
    evidence, _ = _report_totals_evidence(
        _players({"Launches": 0, "hl_Legion": 0, "hl_Swarm": 40, "hl_Faceless": 0})
    )
    assert evidence == {}


def test_the_scraped_faction_does_not_depend_on_row_order():
    """A month split across two scrape bands holds two factions and must still settle.

    The old pick was whichever row an unordered `unique()` yielded last, so the same
    data could attribute the month either way on different runs.
    """
    rows = [
        {"Faction": "Legion", "Launches": 5},
        {"Faction": "Swarm", "Launches": 60},
        {"Faction": "Legion", "Launches": 4},
    ]
    forwards = _scraped_factions(_players(*rows))
    backwards = _scraped_factions(_players(*reversed(rows)))
    assert forwards == backwards == {(JAN, "ann"): "Swarm"}


def test_the_scraped_faction_settles_a_tie_by_name():
    """Equal launches still has to give the same answer twice."""
    rows = [{"Faction": "Swarm", "Launches": 10}, {"Faction": "Legion", "Launches": 10}]
    assert _scraped_factions(_players(*rows)) == {(JAN, "ann"): "Legion"}
    assert _scraped_factions(_players(*reversed(rows))) == {(JAN, "ann"): "Legion"}


def test_a_scrape_band_boundary_is_not_a_player_switching_sides():
    """The backfill walks report numbers a band a night.

    A player who changes faction between two nights has their whole history split at
    that band. Reading the split as switching flags the collection, not the player.
    """
    results = [
        {"Month": JAN, "PlayerName": "ann"},
        {"Month": FEB, "PlayerName": "ann"},
    ]
    _detect_mercenary(results, set(), set(), [{(JAN, "ann"): "Swarm"}, {(FEB, "ann"): "Swarm"}])
    assert [r["IsMercenary"] for r in results] == [False, False]
    assert [r["MercenaryEvidence"] for r in results] == [None, None]


def test_confirmed_factions_that_differ_across_months_do_flag():
    results = [{"Month": JAN, "PlayerName": "ann"}]
    _detect_mercenary(results, set(), set(), [{(JAN, "ann"): "Swarm"}, {(FEB, "ann"): "Legion"}])
    assert results[0]["IsMercenary"] is True
    assert results[0]["MercenaryEvidence"] == "across-months"


def test_evidence_reads_as_a_list_when_more_than_one_thing_says_so():
    results = [{"Month": JAN, "PlayerName": "ann"}]
    _detect_mercenary(
        results,
        {(JAN, "ann")},
        {(JAN, "ann")},
        [{(JAN, "ann"): "Swarm"}, {(FEB, "ann"): "Legion"}],
    )
    assert results[0]["MercenaryEvidence"] == "same-month, zone-names, across-months"
