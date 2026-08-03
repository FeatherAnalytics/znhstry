"""CLI: ``uv run python -m znhstry <step>``."""

from __future__ import annotations

import argparse
import logging
import sys

from . import extract

STEPS = {
    "all": extract.extract_all,
    "lookups": extract.extract_lookups,
    "zones": extract.extract_zones,
    "changelog": extract.extract_changelog,
    "baseline": extract.extract_baseline,
}


def main() -> int:
    parser = argparse.ArgumentParser(prog="znhstry", description="Extract QONQR data to Parquet.")
    parser.add_argument("step", choices=sorted(STEPS), nargs="?", default="all")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    # httpx logs every request at INFO, which drowns out progress.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    STEPS[args.step]()
    return 0


if __name__ == "__main__":
    sys.exit(main())
