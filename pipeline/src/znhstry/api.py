"""Polite client for the QONQR read-only SQL endpoint.

The endpoint takes raw SQL in the URL path and returns ``{"results": [...]}``.
It belongs to someone else, so this module enforces a global minimum interval
between requests, caps concurrency, and backs off on failure.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any
from urllib.parse import quote

import httpx

from . import config

log = logging.getLogger(__name__)


class QueryError(RuntimeError):
    """The server parsed the request but rejected the SQL."""


class _Throttle:
    """Global floor on the gap between request starts, shared across threads."""

    def __init__(self, min_interval: float) -> None:
        self._min_interval = min_interval
        self._lock = threading.Lock()
        self._next_allowed = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            sleep_for = max(0.0, self._next_allowed - now)
            self._next_allowed = max(now, self._next_allowed) + self._min_interval
        if sleep_for:
            time.sleep(sleep_for)


_throttle = _Throttle(config.MIN_REQUEST_INTERVAL)

# One pooled client, reused across threads so connections stay warm.
_client = httpx.Client(
    headers={
        "User-Agent": config.USER_AGENT,
        "Accept-Encoding": "gzip",
    },
    timeout=config.REQUEST_TIMEOUT,
    follow_redirects=True,
)


def query(sql: str) -> list[dict[str, Any]]:
    """Run one SQL statement and return its rows.

    Retries transient network and 5xx failures with exponential backoff.
    A 414 or a SQL error is permanent, so it raises immediately.
    """
    encoded = quote(" ".join(sql.split()), safe="")
    if len(encoded) > config.MAX_SQL_BYTES:
        raise QueryError(
            f"encoded SQL is {len(encoded)}B, over the {config.MAX_SQL_BYTES}B path limit"
        )

    url = config.API_BASE + encoded
    last_error: Exception | None = None

    for attempt in range(config.MAX_RETRIES):
        _throttle.wait()
        try:
            response = _client.get(url)
        except httpx.HTTPError as exc:
            last_error = exc
        else:
            if response.status_code == 414:
                raise QueryError(f"SQL too long for the URL path: {sql[:120]}...")
            if response.status_code >= 500:
                last_error = RuntimeError(f"HTTP {response.status_code}")
            else:
                response.raise_for_status()
                payload = response.json()
                results = payload.get("results")
                # Errors come back as a dict where rows would be a list.
                if isinstance(results, dict) and "error" in results:
                    raise QueryError(f"{results['error']} — for SQL: {sql[:200]}")
                return results or []

        backoff = config.BACKOFF_BASE * (2**attempt)
        log.warning(
            "request failed (%s), retrying in %.0fs [%d/%d]",
            last_error,
            backoff,
            attempt + 1,
            config.MAX_RETRIES,
        )
        time.sleep(backoff)

    raise RuntimeError(f"gave up after {config.MAX_RETRIES} attempts: {last_error}")
