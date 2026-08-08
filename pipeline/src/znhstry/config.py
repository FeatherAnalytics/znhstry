"""Paths, API coordinates, and extraction tuning."""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "data"
RAW = DATA / "raw"


def _load_root_env() -> None:
    """Read the repo-root `.env` into the environment, without overriding it.

    The same file `next.config.ts` reads, so credentials and the data origin are
    configured in exactly one place. Parsed by hand rather than with a
    dependency: it is a dozen `KEY=value` lines and the alternative is pulling
    python-dotenv in for them.

    Anything already set wins, so CI - which passes these as workflow secrets and
    writes no file - is unaffected.
    """
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip().strip("'\"")
        os.environ.setdefault(key, value)


_load_root_env()

# --- Ingest: QONQR's published Dropbox drop -------------------------------
#
# The live source. QONQR writes 31 rotating daily CSVs plus two lookups to a public
# shared folder; this is the same drop the SQL mirror is itself built from, so reading
# it directly costs nobody anything and depends on nobody's server staying up.

LANDING = DATA / "landing"

DROPBOX_LINKS = Path(__file__).with_name("dropbox_links.txt")

# Dropbox serves an HTML interstitial to anything it does not recognise as a downloader
# and there is no Last-Modified on the response, so `?dl=1` is how a file is asked for
# rather than a page about a file. Freshness therefore comes from the dates inside the
# CSV, never from a header.
DROPBOX_DOWNLOAD_PARAM = "dl=1"

# QONQR's Dropbox, not a research box: these can be friendlier than the API limits.
# Still modest - a nightly asks for three files.
DROPBOX_WORKERS = 4
DROPBOX_TIMEOUT = 120.0

# Slot NN of dailyzoneupdates-NN.csv is the day of the month, overwritten in place.
# The ring is the hard limit on how long a gap can be before it is unrecoverable.
RING_SLOTS = 31

API_BASE = "https://api-proxy.auckland-cer.cloud.edu.au/QONQR/"

# The endpoint is a shared research box at the University of Auckland
# (16 gunicorn workers). Identify ourselves and stay well under capacity.
USER_AGENT = "znhstry/0.1 (personal analytics project; github.com/mrbri/znhstry)"

MAX_WORKERS = 3          # of the server's 16
MIN_REQUEST_INTERVAL = 0.5   # seconds between request starts, global
REQUEST_TIMEOUT = 300.0
MAX_RETRIES = 4
BACKOFF_BASE = 2.0

# SQL rides in the URL path; the server returns 414 somewhere between 6KB and 9KB.
MAX_SQL_BYTES = 6000

# changelog history. Rows before this are the 2010-01-01 backfill sentinel:
# 1,449,170 of them, of which only 29 carry any bots. Those 29 are pulled
# separately by extract_baseline(); everything else is genuinely zero.
HISTORY_START = date(2012, 1, 1)
SENTINEL_CUTOFF = date(2012, 1, 1)

# Event volume is wildly uneven: ~2.0M events across 2012-2019, then ~1.3M
# per year from 2020. Yearly chunks early, monthly chunks once it gets dense,
# so no single response is enormous and no request is mostly overhead.
MONTHLY_FROM_YEAR = 2020

# Upper bound is discovered at runtime, not hardcoded: new zones appear above
# the previous maximum over time, and a stale constant would silently skip them.
ZONE_ID_CHUNK = 200_000
ZONE_ID_HEADROOM = 200_000

# --- Export ---------------------------------------------------------------

DUCKDB_PATH = DATA / "znhstry.duckdb"

# The export is served from object storage, not from the site bundle, because
# it needs response headers the site's host cannot set: `Content-Encoding: br`
# (18% smaller than gzip, and the browser decompresses it, so the client needs
# no decoding code at all) and a year-long immutable `Cache-Control` on the
# shards that never change. It also keeps 105 MB of nightly-rewritten binaries
# out of the site build entirely.
WEB_DATA = ROOT / "dist" / "data"

EARTH_RADIUS_KM = 6371.0088


@dataclass(frozen=True)
class Scope:
    """A geographic slice to export.

    The radius fields are kept because `_create_scope` still implements the
    haversine filter, but nothing sets them: the site is global and a partial
    export was only ever a way to iterate faster before the format was settled.
    """

    name: str
    label: str
    lat: float | None = None
    lon: float | None = None
    radius_km: float | None = None
    # 1,087,353 zones have never recorded a single bot in fourteen years. They
    # carry no history, but they are real places on the map and the viewer draws
    # them as faint grey dots so the world is whole rather than only showing
    # where the fighting was. They ride in the lowest-priority geometry tiles
    # and never appear in the display stream.
    active_only: bool = False


SCOPES = {"global": Scope(name="global", label="Global")}

DEFAULT_SCOPE = "global"

# Day numbers in the packed event stream count from here, so they fit a uint16
# (max 65,535 days ~ 179 years of headroom).
#
# 2010, not 2012: the 29 nonzero backfill sentinel rows are dated 2010-01-01,
# and any epoch after them makes their day offset negative. Under a uint16 that
# underflows into a plausible-looking future date instead of failing.
DAY_EPOCH = date(2010, 1, 1)

# QONQR released on 2012-07-30. Everything before it is pre-release testing: 11
# scattered events between 2012-05-19 and 2012-07-29, plus the 29 backfill
# sentinel rows dated 2010-01-01. The export drops all of it, so "All time"
# means the life of the game rather than the life of the table.
#
# Cheap to do: 40 events across 40 zones, only 7 of which have no later event
# and therefore stop counting as ever-played.
RECORD_START = date(2012, 7, 30)
