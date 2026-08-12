"""The flashpoint payload's two halves have to agree, and nothing else would say so.

`flashpoints.bin.br` carries a uint8 `flashpoint` column that is a *position* in the
manifest's `entries` list, not an id. That is the frugal shape - ten strings per row would
be most of the payload - and it is only safe while the shard's codes and the list's order
come from the same ordering.

A drift here is invisible in every direction. The shard still parses, every code still
addresses a real entry, and the panel still draws two plausible lines: they would simply be
the wrong flashpoint's. The first symptom would be a reader wondering why Dallas looks like
Marquette.

These run against the real export when it is present and skip otherwise, because the thing
under test is the payload agreeing with itself over real rows.
"""

from __future__ import annotations

import json

import brotli
import numpy as np
import pytest

from znhstry import config

SCOPE = config.WEB_DATA / config.DEFAULT_SCOPE


def _meta() -> dict:
    return json.loads((SCOPE / "meta.json").read_text(encoding="utf-8"))


pytestmark = pytest.mark.skipif(not (SCOPE / "meta.json").exists(), reason="export not written")


@pytest.fixture(scope="module")
def meta() -> dict:
    return _meta()


@pytest.fixture(scope="module")
def shard(meta) -> dict[str, np.ndarray]:
    entry = meta["flashpoints"]
    payload = brotli.decompress((SCOPE / entry["path"]).read_bytes())
    rows = entry["rows"]
    columns: dict[str, np.ndarray] = {}
    offset = 0
    for name, dtype, encoding in entry["columns"]:
        column = np.frombuffer(payload, dtype=dtype, count=rows, offset=offset)
        offset += rows * np.dtype(dtype).itemsize
        columns[name] = column.cumsum(dtype="int64") if encoding == "delta" else column
    assert offset == len(payload), "columns do not account for the payload"
    return columns


def test_every_code_addresses_an_entry(meta, shard):
    entries = meta["flashpoints"]["entries"]
    codes = np.unique(shard["flashpoint"])
    assert codes.min() >= 0
    assert codes.max() < len(entries)


def test_coverage_agrees_with_the_board_rows_in_both_directions(meta, shard):
    """The flag and the rows have to say the same thing, each way round.

    Six of the ten flashpoints predate usable changelog coverage, so the empty case is
    the common one and is exactly what a positional mix-up would hide: rows would still
    exist for every code, just attributed wrongly.

    The assertion is specifically about `on_the_board` rows, not rows at all. Breda,
    Chermignac and Dartford are uncovered and still carry neighbor rows - their circles
    had zones moving in the window while the zones actually reported fighting did not.
    """
    board = shard["flashpoint"][shard["on_the_board"] == 1]
    with_board_rows = set(np.unique(board).tolist())
    for position, entry in enumerate(meta["flashpoints"]["entries"]):
        has_rows = position in with_board_rows
        assert has_rows == entry["changelog_covered"], entry["id"]


def test_days_fall_inside_the_run_window(meta, shard):
    """A row outside its own window would be drawn at the wrong end of the chart."""
    for position, entry in enumerate(meta["flashpoints"]["entries"]):
        rows = shard["flashpoint"] == position
        if not rows.any():
            continue
        run_start, run_end = entry["run"]
        days = shard["day"][rows]
        assert days.min() >= run_start, entry["id"]
        assert days.max() <= run_end, entry["id"]


def test_board_zones_are_a_non_empty_subset_of_the_circle(meta):
    for entry in meta["flashpoints"]["entries"]:
        assert 0 < len(entry["board_idx"]) <= entry["zones_in_circle"], entry["id"]
        assert len(set(entry["board_idx"])) == len(entry["board_idx"]), entry["id"]


def test_the_board_window_sits_inside_the_run_window(meta):
    """Playback has to cover the days the marks are drawn for."""
    for entry in meta["flashpoints"]["entries"]:
        board_start, board_end = entry["board"]
        run_start, run_end = entry["run"]
        assert run_start <= board_start <= board_end <= run_end, entry["id"]
