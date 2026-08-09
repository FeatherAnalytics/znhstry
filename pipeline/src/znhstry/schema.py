"""The dtype contract for everything written under `data/raw`.

DuckDB reads a year-partitioned set through a single glob, so a column that differs in
width or signedness between two files does not merely look inconsistent - it makes the
source unreadable. Nothing declares its own types; every writer conforms to this, which
is also what lets a partition written years apart from its neighbour still read.

The widths are load-bearing rather than arbitrary, and the warehouse is built on them:

- `ZoneId` is Int32 because the maximum is ~2.8M and a zone id is never negative, but
  Int32 leaves room for the ones that appear above the previous maximum over time.
- `ZoneControlState` is Int8 - four factions, 0..3.
- The bot counts are Int64. They are not close to overflowing Int32 today, but they are
  the numbers the whole site is about and a silent wrap would be invisible in a map.
"""

from __future__ import annotations

import polars as pl

# One row per zone per observation. The event stream everything else derives from.
CHANGELOG_COLUMNS: tuple[str, ...] = (
    "ZoneId",
    "LastUpdateDateUtc",
    "DateCapturedUtc",
    "ZoneControlState",
    "LegionCount",
    "SwarmCount",
    "FacelessCount",
)

CHANGELOG_DTYPES: dict[str, pl.DataType] = {
    "ZoneId": pl.Int32,
    "LastUpdateDateUtc": pl.Datetime("us"),
    "DateCapturedUtc": pl.Datetime("us"),
    "ZoneControlState": pl.Int8,
    "LegionCount": pl.Int64,
    "SwarmCount": pl.Int64,
    "FacelessCount": pl.Int64,
}

# Current state and geography, one row per zone. `TotalCount` is stored rather than
# derived because it is what the upstream table carries; it is recomputed on ingest so
# it can never disagree with its three parts.
ZONE_COLUMNS: tuple[str, ...] = (
    "ZoneId",
    "Description",
    "RegionId",
    "CountryId",
    "ZoneControlState",
    "DateCapturedUtc",
    "LastUpdateDateUtc",
    "Latitude",
    "Longitude",
    "LegionCount",
    "SwarmCount",
    "FacelessCount",
    "TotalCount",
)

ZONE_DTYPES: dict[str, pl.DataType] = {
    "ZoneId": pl.Int32,
    "Description": pl.String,
    "RegionId": pl.Int32,
    "CountryId": pl.Int32,
    "ZoneControlState": pl.Int8,
    "DateCapturedUtc": pl.Datetime("us"),
    "LastUpdateDateUtc": pl.Datetime("us"),
    "Latitude": pl.Float64,
    "Longitude": pl.Float64,
    "LegionCount": pl.Int64,
    "SwarmCount": pl.Int64,
    "FacelessCount": pl.Int64,
    "TotalCount": pl.Int64,
}

# `(ZoneId, LastUpdateDateUtc)` is unique across all 9,878,738 historical rows, which is
# what makes an append safe to run twice. Re-reading a slot that is already merged is a
# no-op rather than a duplicate, so a retried nightly costs nothing but the fetch.
EVENT_KEY: tuple[str, ...] = ("ZoneId", "LastUpdateDateUtc")


def conform(df: pl.DataFrame, dtypes: dict[str, pl.DataType]) -> pl.DataFrame:
    """Select the contract's columns, in order, at the contract's types.

    Raises rather than filling a missing column with nulls: an absent column means the
    upstream format changed, and inventing nulls for it would push the failure into
    whichever mart happened to read it next.
    """
    missing = [c for c in dtypes if c not in df.columns]
    if missing:
        raise ValueError(f"source is missing {missing}; got {df.columns}")
    return df.select([pl.col(c).cast(dtype) for c, dtype in dtypes.items()])
