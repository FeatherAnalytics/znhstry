from datetime import datetime

from znhstry.atlantis import parse_page

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
