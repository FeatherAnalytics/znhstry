"""Battle report parsing, against real pages saved from the portal.

The fixtures are whole pages rather than trimmed snippets, because the parser reads the
page's own structure - stat labels from the text, faction names from CSS classes - and a
snippet would only prove it can read the snippet.

The value of these tests is the column contract. 61,517 reports were seeded from a
community scrape and everything new has to land in the same 77 columns under the same
names, or the raw layer quietly splits into two shapes that only diverge downstream.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from znhstry import config
from znhstry.portal import ReportUnavailable, _targets, most_active_zones, parse_report

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def report() -> dict:
    html = (FIXTURES / "battle_report_131012.html").read_text(encoding="utf-8")
    return parse_report(131012, html)


def test_the_column_contract_is_77_fields(report):
    assert len(report) == 77


def test_identity_fields(report):
    assert report["Battle Report Number"] == 131012
    assert report["Zone Name"] == "Dover Heights"
    assert report["Region"] == "New South Wales"
    assert report["Country"] == "Australia"
    assert report["Zone ID"] == 12642


def test_dates_are_month_first(report):
    """`8/7/2026` is August 7th, not July 8th.

    For any day under 13 the wrong reading is also a valid date, so this would be
    invisible in the data and wrong by up to eleven months.
    """
    assert report["Date"] == date(2026, 8, 7)


def test_thousands_separator_is_stripped(report):
    # Rendered as "1 666" with a plain space.
    assert report["Total Launches"] == 1666


def test_progress_bars_map_to_the_right_faction_and_end(report):
    """Six bars in one list, and the page gives no labels - only order.

    Swapping starting for ending, or one faction for another, produces numbers that
    look entirely plausible. These are the values on the real page.
    """
    assert report["Swarm Starting Bots"] == 517
    assert report["Legion Starting Bots"] == 0
    assert report["Faceless Starting Bots"] == 1158954
    assert report["Swarm Ending Bots"] == 0
    assert report["Legion Ending Bots"] == 0
    assert report["Faceless Ending Bots"] == 258040


def test_faction_breakdowns_sum_to_their_total(report):
    for stat in ("Total Active Players", "Total Launches", "Bots Launched"):
        parts = sum(report[f"{f} {stat}"] for f in ("Swarm", "Legion", "Faceless"))
        assert parts == report[stat], stat


def test_players_are_captured(report):
    assert report["players"].startswith("1,sethowar,")


def test_a_page_with_no_report_is_not_an_error():
    """The report-number range is sparse, so misses are the normal case."""
    with pytest.raises(ReportUnavailable):
        parse_report(999999, "<html><body><h1>/</h1></body></html>")


def test_most_active_zones_lists_ten(monkeypatch):
    class FakeResponse:
        text = (FIXTURES / "most_active_zones.html").read_text(encoding="utf-8")

        def raise_for_status(self):
            return None

    class FakeClient:
        def get(self, url):
            return FakeResponse()

    listed = most_active_zones(FakeClient())
    assert listed == list(range(131012, 131022))


def test_targets_skips_what_we_already_have():
    assert _targets([10, 11, 12], {10, 11, 12}) == []
    assert _targets([10, 11, 12], {10}) == [11, 12]


def test_targets_fills_a_gap_the_index_does_not_show():
    """The index only ever names today's ten.

    Reports from a missed day appear on no index anywhere, so the span between what we
    hold and what is listed has to be walked by number or those days are lost.
    """
    assert _targets([20, 21], {10}) == list(range(11, 22))


def test_targets_caps_a_catch_up():
    """A long outage must resume over several runs, not crawl thousands of pages."""
    targets = _targets([100_000], {1})
    assert len(targets) == config.PORTAL_MAX_PER_RUN
    assert targets[0] == 2
