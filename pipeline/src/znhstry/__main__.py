"""CLI: ``uv run python -m znhstry <step>``."""

from __future__ import annotations

import argparse
import logging
import os
import sys

from . import boundaries, config, export, extract, ingest, upload

STEPS = {
    # The live path: QONQR's published Dropbox drop.
    "ingest": ingest.ingest_daily,
    "export": export.export_all,
    "upload": upload.upload_all,
    # The raw layer's durable copy. `restore` is the first step on a fresh clone:
    # the 31-slot ring cannot seed a history it does not hold.
    "archive": upload.archive_raw,
    "restore": upload.restore_raw,
    # One-time move off the API-era file layouts.
    "migrate": ingest.migrate,
    # Scope-independent and rarely rerun.
    "boundaries": boundaries.export_boundaries,
    # The SQL mirror. Not on any scheduled path -- kept to verify the ingest above
    # against the source it replaced, and to seed history the 31-slot ring cannot reach.
    "all": extract.extract_all,
    "lookups": extract.extract_lookups,
    "zones": extract.extract_zones,
    "changelog": extract.extract_changelog,
    "baseline": extract.extract_baseline,
    "update": extract.extract_update,
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
    parser.add_argument(
        "--slots",
        help=(
            "Ingest step only. Comma-separated ring slots (days of the month) to read, "
            "e.g. '7' or '5,6,7'. Default is whichever days the history is missing, "
            "normally just the one that closed at midnight."
        ),
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
    elif args.step == "ingest":
        slots = [int(s) for s in args.slots.split(",")] if args.slots else None
        added = ingest.ingest_daily(slots)
        # A night with nothing new should not spend 26 minutes rebuilding an identical
        # export. The count goes out as a step output so the workflow can stop here.
        _emit(events=sum(added.values()))
    else:
        STEPS[args.step]()
    return 0


def _emit(**values: object) -> None:
    """Write `key=value` lines to $GITHUB_OUTPUT when running under Actions."""
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")


if __name__ == "__main__":
    sys.exit(main())
