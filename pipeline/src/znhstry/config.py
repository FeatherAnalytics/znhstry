"""Paths, API coordinates, and extraction tuning."""

from __future__ import annotations

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

ZONE_ID_MAX = 2_836_389
ZONE_ID_CHUNK = 200_000
