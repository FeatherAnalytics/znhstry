"""Paths, API coordinates, and extraction tuning."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "data"
RAW = DATA / "raw"

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
WEB_DATA = ROOT / "web" / "public" / "data"

EARTH_RADIUS_KM = 6371.0088

# Checkpoints, events and chart series shard by web-mercator tile so a viewport
# fetches only what it can see. Zoom 4 measured best: 128 of the 256 tiles hold
# any zone at all, and the heaviest (North America, x=8 y=5) is 19% of zones and
# 27% of events -- a real cut without splitting into thousands of tiny files.
#
# Tile assignment derives from latitude and longitude, which never change, so a
# zone's tile is stable forever. That is what lets the shards stay immutable.
TILE_ZOOM = 4
# Web mercator is undefined at the poles; this is where the projection is
# conventionally truncated to make the world square.
MERCATOR_LAT_LIMIT = 85.05112878


@dataclass(frozen=True)
class Scope:
    """A geographic slice to export.

    `global` is the destination; the Dallas radius is a smaller fixture to
    develop the viewer against. Both go through the same code path so nothing
    has to be rewritten to scale up.
    """

    name: str
    label: str
    lat: float | None = None
    lon: float | None = None
    radius_km: float | None = None
    # 1,087,353 zones have never recorded a single bot in fourteen years. They
    # cannot render and cannot be queried usefully, so they are excluded by
    # default -- a 40% cut to the two largest global payloads.
    active_only: bool = True


SCOPES = {
    # Dallas, TX is ZoneId 1529645, the largest zone in Texas by an order of magnitude.
    "dallas-1000mi": Scope(
        name="dallas-1000mi",
        label="Dallas, TX - 1000 miles",
        lat=32.7831,
        lon=-96.8067,
        radius_km=1609.344,  # 1000 statute miles
    ),
    "global": Scope(name="global", label="Global"),
}

DEFAULT_SCOPE = "dallas-1000mi"

# Day numbers in the packed event stream count from here, so they fit a uint16
# (max 65,535 days ~ 179 years of headroom).
#
# 2010, not 2012: the 29 nonzero backfill sentinel rows are dated 2010-01-01,
# and any epoch after them makes their day offset negative. Under a uint16 that
# underflows into a plausible-looking future date instead of failing.
DAY_EPOCH = date(2010, 1, 1)
