from datetime import datetime

from znhstry.atlantis import _next_collection, parse_page

# The battle can be under way before the page shows "Stacking Days / Battle Days".
_PAGE_WITHOUT_SCHEDULE = """
<div class="row">
  <h1>Atlantis Leaderboard</h1>
  <table><tr class="Swarm"><td>1</td><td></td><td><a>tedly</a></td><td>1 234</td></tr></table>
</div>
"""


def test_board_is_kept_when_the_schedule_is_missing() -> None:
    page = parse_page(_PAGE_WITHOUT_SCHEDULE, datetime(2026, 10, 1, 1, 7))

    assert page.schedule is None
    assert page.leaderboard["PlayerName"].to_list() == ["tedly"]
    assert page.tournament.is_empty()


def test_next_collection_is_the_next_boundary_not_five_minutes_on() -> None:
    # The Worker ticks at :02, :07, ...; observed_at + 5m would land after the next tick.
    assert _next_collection(datetime(2026, 12, 1, 0, 2, 40)) == datetime(2026, 12, 1, 0, 5)
    assert _next_collection(datetime(2026, 12, 1, 23, 57, 10)) == datetime(2026, 12, 2, 0, 0)
