"""Collect the portal's daily cube-to-Qredit exchange rate from `/Depot/Exchange`.

The page states "Today's Exchange Rate 1 = 6500": one cube buys that many Qredits. It is
login-only, so this signs in with the same account as `profiles`. One row per UTC date;
a second read on the same day replaces the first, so the table holds the day's latest.

Dates before 2026-11-16 were backfilled once from `neon-ninja/QONQR_zonedata`'s
`exchange_rates.csv` and carry `source = 'neon-ninja'` and no `observed_at`. Its value for
2026-11-16 matched our own read.
"""

from __future__ import annotations

import logging
import re
import time
from datetime import UTC, datetime

import polars as pl
from bs4 import BeautifulSoup

from . import config, profiles

log = logging.getLogger(__name__)

EXCHANGE_PATH = "/Depot/Exchange"
PATH = config.RAW / "depot" / "exchange_rates.parquet"
SCHEMA = {
    "rate_date": pl.Date,
    "observed_at": pl.Datetime("us"),
    "qredits_per_cube": pl.Int32,
    "source": pl.String,
}

_RATE = re.compile(r"Today's Exchange Rate\s*1\s*=\s*([\d\s,]+)")


def parse_rate(html: str) -> int:
    text = BeautifulSoup(html, "html.parser").get_text(" ", strip=True)
    match = _RATE.search(text)
    if match is None:
        raise ValueError("no exchange rate on /Depot/Exchange; the page has changed")
    return int(re.sub(r"\D", "", match.group(1)))


def scrape_exchange_rate() -> int:
    with profiles._client() as client:
        profiles.login(client)
        time.sleep(config.PROFILE_INTERVAL)
        html = profiles._fetch_page(client, EXCHANGE_PATH)
    if html is None:
        raise RuntimeError("every retry of /Depot/Exchange hit the error page")
    observed_at = datetime.now(UTC).replace(tzinfo=None, microsecond=0)
    rate = parse_rate(html)
    row = pl.DataFrame(
        [{
            "rate_date": observed_at.date(),
            "observed_at": observed_at,
            "qredits_per_cube": rate,
            "source": "portal",
        }],
        schema=SCHEMA,
    )
    frames = [pl.read_parquet(PATH), row] if PATH.exists() else [row]
    merged = pl.concat(frames).unique(subset="rate_date", keep="last").sort("rate_date")
    PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = PATH.with_name(PATH.name + ".tmp")
    merged.write_parquet(tmp, compression="zstd")
    tmp.replace(PATH)
    log.info("exchange: 1 cube = %s Qredits on %s", f"{rate:,}", observed_at.date())
    return rate
