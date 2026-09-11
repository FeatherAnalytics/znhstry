"""CLI: ``uv run python -m znhstry <step>``."""

from __future__ import annotations

import argparse
import logging
import os
import sys

from . import (
    atlantis,
    attribute,
    boundaries,
    config,
    export,
    ingest,
    marts,
    portal,
    upload,
    wayback,
)


def main() -> int:
    parser = argparse.ArgumentParser(prog="znhstry", description="Zone History pipeline.")
    parser.add_argument("step", choices=sorted(_DISPATCH), nargs="?", default="ingest")
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
        "--dry-run",
        action="store_true",
        help="Backfill step only. Print targets without fetching.",
    )
    parser.add_argument(
        "--only",
        choices=["atlantis"],
        help="Export step only. Rebuild only the named tree and patch meta.json.",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    # httpx logs every request at INFO, which drowns out progress.
    logging.getLogger("httpx").setLevel(logging.WARNING)

    _run_step(args)
    return 0


def _run_ingest(args: argparse.Namespace) -> None:
    slots = [int(s) for s in args.slots.split(",")] if args.slots else None
    _emit(events=sum(ingest.ingest_daily(slots).values()))


def _run_upload(args: argparse.Namespace) -> None:
    (upload.upload_marts if args.marts else upload.upload_all)()


def _run_wayback() -> None:
    missing = wayback.ingest_wayback()
    _emit(missing=missing)
    if missing:
        raise SystemExit(1)


_DISPATCH = {
    "export": lambda a: (
        export.export_atlantis_only(a.scope) if a.only == "atlantis"
        else export.export_all(a.scope)
    ),
    "ingest": _run_ingest,
    "battlestats": lambda _: _emit(reports=portal.scrape_battlestats()),
    "backfill": lambda a: _emit(pages=portal.backfill_players(dry_run=a.dry_run)),
    "atlantis": lambda _: _emit(rows=atlantis.scrape_atlantis()),
    "wayback": lambda _: _run_wayback(),
    "attribute": lambda _: attribute.attribute_factions(),
    "upload": _run_upload,
    "archive": lambda a: upload.archive_raw(prefix=a.prefix),
    "restore": lambda a: upload.restore_raw(prefix=a.prefix),
    "boundaries": lambda _: boundaries.export_boundaries(),
    "marts": lambda _: marts.export_marts(),
}


def _run_step(args: argparse.Namespace) -> None:
    _DISPATCH[args.step](args)


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
