"""Battle report parsing, against real pages saved from the portal.

The fixtures are whole pages rather than trimmed snippets, because the parser reads the
page's own structure - stat labels from the text, faction names from CSS classes - and a
snippet would only prove it can read the snippet.

The value of these tests is the column contract. 61,517 reports were seeded from a
community scrape and everything new has to land in the same 77 columns under the same
names, or the raw layer quietly splits into two shapes that only diverge downstream.
"""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path

import pytest

from znhstry import config
from znhstry.portal import (
    ReportUnavailable,
    _targets,
    checked_through,
    most_active_zones,
    parse_report,
    record_checked,
)

FIXTURES = Path(__file__).parent / "fixtures"

# Enough of a report to get past every "there is no report here" check and then fail on
# the page's own contents: six progress bars, one of which is not a number.
BROKEN_REPORT = (
    "<html><body>"
    "<h1>Dover Heights<br/>New South Wales / Australia<br/>#12642</h1>"
    "<strong>8/7/2026</strong>"
    + '<div class="progress">not a number</div>' * 6
    + "</body></html>"
)


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


def test_fixtures_carry_no_third_party_credentials():
    """These are whole pages saved from someone else's site.

    QONQR's page ships its own Mapbox token in the markup, and saving the page
    captured it. It is a publishable `pk.` token rather than a private key, but it is
    their credential and it has no business in this repo - GitHub's push protection
    caught it, which is a worse place to find out than here.
    """
    pattern = re.compile(r"(?:pk|sk)\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]+")
    for page in FIXTURES.glob("*.html"):
        found = pattern.findall(page.read_text(encoding="utf-8"))
        assert found == [] or all("REDACTED" in f for f in found), page.name


def test_targets_caps_a_catch_up():
    """A long outage must resume over several runs, not crawl thousands of pages."""
    targets = _targets([100_000], {1})
    assert len(targets) == config.PORTAL_MAX_PER_RUN
    assert targets[0] == 2


def test_the_walk_resumes_past_numbers_that_had_no_report():
    """Half the range is empty, so a whole batch coming back dead is normal.

    Nothing lands on disk when it does, so `max(have)` has not moved and the same
    forty numbers are walked again the next night, and every night after - a stall
    that looks exactly like a quiet day in the log.
    """
    first = _targets([100_000, 100_001], {10})
    assert first[0] == 11
    assert len(first) == config.PORTAL_MAX_PER_RUN

    resumed = _targets([100_000, 100_001], {10}, checked=first[-1])
    assert resumed[0] == first[-1] + 1


def test_how_far_the_walk_got_only_ever_moves_forward(tmp_path, monkeypatch):
    """Re-reading an old slot by hand must not roll the walk backwards."""
    monkeypatch.setattr(config, "RAW", tmp_path)

    assert checked_through() == 0
    record_checked(120)
    assert checked_through() == 120
    record_checked(90)
    assert checked_through() == 120


def test_a_page_the_parser_cannot_read_is_a_parse_error():
    """Which is what the scrape loop catches per report rather than per run.

    A page whose shape has moved raises out of the parser, and left alone it discards
    every other report the run has already fetched - forty pages of a stranger's
    bandwidth, thrown away and asked for again tomorrow.
    """
    with pytest.raises(ValueError):
        parse_report(131012, BROKEN_REPORT)
