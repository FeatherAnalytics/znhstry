"""CLI: ``uv run python -m znhstry <step>``."""

from __future__ import annotations

import argparse
import logging
import os
import sys

from . import atlantis, boundaries, config, export, hydrate, ingest, marts, portal, upload

STEPS = {
    "ingest": ingest.ingest_daily,
    # Battle reports come from the game's live portal, not the Dropbox drop, so they are
    # their own step: the map must not fail to publish because a web page was slow.
    "battlestats": portal.scrape_battlestats,
    # The monthly tournament page, read hourly while a battle is on. Its own step because
    # it runs on the tournament's clock, not the nightly's.
    "atlantis": atlantis.scrape_atlantis,
    "export": export.export_all,
    # The same marts as Parquet, for anything that reads the warehouse from outside the
    # map. `upload --marts` sends them; the export's upload never sees them.
    "marts": marts.export_marts,
    "upload": upload.upload_all,
    # Reads the published export back into a warehouse anyone can query. The only
    # route to the history that needs no credentials.
    "hydrate": hydrate.hydrate,
    # The raw layer's durable copy. `restore` is the first step on a fresh clone:
    # the 31-slot ring cannot seed a history it does not hold.
    "archive": upload.archive_raw,
    "restore": upload.restore_raw,
    # Scope-independent and rarely rerun.
    "boundaries": boundaries.export_boundaries,
}


def main() -> int:
    parser = argparse.ArgumentParser(prog="znhstry", description="Zone History pipeline.")
    parser.add_argument("step", choices=sorted(STEPS), nargs="?", default="ingest")
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
    parser.add_argument(
        "--prefix",
        default="",
        help=(
            "Archive and restore steps only. Only the part of data/raw under this relative "
            "prefix, e.g. 'atlantis/'."
        ),
    )
    parser.add_argument(
        "--marts",
        action="store_true",
        help="Upload step only. Send dist/marts to the bucket under marts/ instead of the export.",
    )
    parser.add_argument(
        "--origin",
        help=(
            "Hydrate step only. Base URL of a published export. Defaults to the "
            "project's own public bucket, so a fresh clone needs no configuration."
        ),
    )
    parser.add_argument(
        "--no-names",
        action="store_true",
        help="Hydrate step only. Skip the 655 name blocks, which are most of the requests.",
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="Hydrate step only. Build from the cache alone, manifest included.",
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
    elif args.step == "battlestats":
        _emit(reports=portal.scrape_battlestats())
    elif args.step == "atlantis":
        _emit(rows=atlantis.scrape_atlantis())
    elif args.step == "upload":
        (upload.upload_marts if args.marts else upload.upload_all)()
    elif args.step == "hydrate":
        hydrate.hydrate(args.origin, names=not args.no_names, offline=args.offline)
    elif args.step == "archive":
        upload.archive_raw(prefix=args.prefix)
    elif args.step == "restore":
        upload.restore_raw(prefix=args.prefix)
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
