"""CLI: ``uv run python -m znhstry <step>``."""

from __future__ import annotations

import argparse
import logging
import sys

from . import boundaries, config, export, extract

STEPS = {
    "all": extract.extract_all,
    "lookups": extract.extract_lookups,
    "zones": extract.extract_zones,
    "changelog": extract.extract_changelog,
    "baseline": extract.extract_baseline,
    "update": extract.extract_update,
    "export": export.export_all,
    # Scope-independent and rarely rerun, but it was previously reachable only
    # by importing the module by hand, which meant nobody could rebuild it.
    "boundaries": boundaries.export_boundaries,
}


def main() -> int:
    parser = argparse.ArgumentParser(prog="znhstry", description="Extract QONQR data to Parquet.")
    parser.add_argument("step", choices=sorted(STEPS), nargs="?", default="all")
    parser.add_argument(
        "--scope",
        choices=sorted(config.SCOPES),
        default=config.DEFAULT_SCOPE,
        help="Geographic slice to export (export step only).",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    # httpx logs every request at INFO, which drowns out progress.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if args.step == "export":
        export.export_all(args.scope)
    else:
        STEPS[args.step]()
    return 0


if __name__ == "__main__":
    sys.exit(main())
