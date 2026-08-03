# znhstry (Zone History)

Historical visualization of QONQR zone control: current state, state over time, and
period-over-period change. Public read-only SQL mirror -> Parquet -> dbt/DuckDB -> deck.gl dashboard.

**Slug is `znhstry`; display name is "Zone History".** Use the display name in page titles,
headings, and prose. The slug is for the repo, URL, and package only.

## Tech Stack

- **Python** 3.13+, managed by `uv`. Type hints on functions. Lint with `ruff`.
- **Extract**: `httpx` + `polars` -> Parquet in `data/raw/`.
- **Transform**: dbt-duckdb (not yet built).
- **Web**: Next.js static export + deck.gl (not yet built).
- **Deploy**: GitHub Pages at `featheranalytics.dev/znhstry`.

## Commands

```bash
cd pipeline
uv run python -m znhstry all         # full extraction (idempotent, resumable)
uv run python -m znhstry changelog   # one step: lookups|zones|changelog|baseline
```

## Upstream API

`https://api-proxy.auckland-cer.cloud.edu.au/QONQR/<url-encoded SQL>` — SQL in the URL
**path**, not a query param. Full data dictionary: `QONQR-API-data-dictionary.md` in the
Code root. Reference implementation: `../QONQR` (neon-ninja), a current-state Leaflet map
with no time dimension.

**This is someone else's research box** (16 gunicorn workers, University of Auckland).
`api.py` caps concurrency at 3, enforces a 0.5s global floor between requests, and sends a
identifying User-Agent. Do not raise those limits. Once extraction is done the API is only
needed for nightly incremental top-ups.

- Returns 414 for SQL between 6KB and 9KB encoded. `MAX_SQL_BYTES` guards at 6000.
- Errors come back as HTTP 200 with `{"results": {"error": ...}}` — a dict where rows
  would be a list. `api.query()` raises on that shape.
- CORS is `*` and gzip is supported, so the browser *could* query it directly. Don't;
  the volumes are too large and it isn't our server to lean on.

## Data facts (measured, not guessed)

- **`changelog` is a sparse event stream.** A row exists only when a zone's counts or
  control state changed. 9.87M real events across 2012-05-19 to present.
- **Carry-forward is the core modelling problem.** 504,410 zones (32% of those ever
  active) last changed in 2019 or earlier. Any time-window slice that ignores older
  events loses their state entirely. Zone-level state at time T needs year checkpoints
  plus intra-year deltas; aggregates need cumulative-sum-of-deltas, never forward-fill.
- **Pre-2012 rows are backfill sentinels.** 1,449,170 of them, of which only **29** carry
  any bots. Extraction skips the rest and treats pre-first-event state as zero.
  `extract_baseline()` pulls those 29 separately.
- **2019 has a collection gap**: 337,859 events vs 627,035 in 2018 and 1,438,855 in 2020.
  This is almost certainly missing data, not a quiet year. Annotate it in any continuous
  time series; do not silently interpolate.
- **Only 1,595,083 of 2,682,442 zones have ever changed.** The rest hold nothing.
- **`zones.*Delta` columns are useless to us** — they span the gap between the two most
  recent observations, which may be years. We recompute deltas from `changelog`.
  `TotalDelta` is also absolute (churn), never negative. Not extracted.
- **`Description` is not unique** — many zones share a name. `ZoneId` is the only key.
  Dallas, TX is `ZoneId 1529645` at (32.7831, -96.8067).
- **`battlestats` column names contain spaces** and need backticks.
  `Country = 'Atlantis'` marks test/tutorial zones — exclude.
- Per-player data (`battlestats_players.csv`, `player_details.csv`) is **not in the
  database**, only in the upstream repo `../QONQR_zonedata`.

### changelog does not perfectly reconcile to zones

Cumulative deltas from `changelog` land ~0.004% above the `zones` table. The gap
decomposes exactly, with no remainder:

| Faction | Total gap | 3 orphan zones | 1,429 divergent zones |
|---|---|---|---|
| Legion | 441,292 | 0 | 441,292 |
| Swarm | 1,070,874 | 722,697 | 348,177 |
| Faceless | 160,730 | 0 | 160,730 |

- **3 orphan zones** (`2836390`, `2836391`, `2836392`) exist in `changelog` but not in
  `zones`. They land in `fct_zone_events` with a null `country_id`, so they count toward
  `fct_global_daily` but not `fct_country_daily`. Do not "fix" this by inner-joining.
- **1,429 zones (0.09%)** have a last `changelog` row that disagrees with their `zones`
  row, always with `changelog` higher. The data dictionary claims these always match;
  they match for 99.91%. Upstream runs `import_mysql.py` and `import_mysql_changelog.py`
  as separate steps, so the two can drift.

0.004% of bots is immaterial for a visualization. It is documented rather than tested
against a threshold, because thresholds on upstream drift are brittle.

### Fixed bugs worth not reintroducing

- **`fct_zone_checkpoints` must compare timestamps, not dates.** Casting to date drops
  every boundary an event lands on -- the preceding event fails `next > B` and the event
  itself fails `B > observed`, so no row matches. This silently lost 19,062 checkpoints.
  `tests/assert_one_checkpoint_per_zone_boundary.sql` guards it.
- **Do not hardcode a max ZoneId.** New zones appear above the previous maximum;
  `extract_zones()` discovers it at runtime and adds headroom.
- **A bbox prefilter must never be tighter than the circle it precedes.** 111.32 km per
  degree of latitude is a mid-latitude average; a real degree is shorter, so an unpadded
  box is narrower than its radius and clips edge zones before haversine runs.
  `_BBOX_MARGIN = 1.05` in `export.py`. The true count within 1000 mi of Dallas is
  **146,537**; the 146,469 quoted during feasibility work was clipped by exactly this
  mistake in the hand-written API query.
- **Guard packed integer columns for overflow and sign.** `day` is a uint16 offset from
  `DAY_EPOCH` (2012-01-01); a 2010 backfill row would underflow into a plausible-looking
  date rather than failing. `_write_columnar` checks bounds before writing.
- `matched` is a reserved word in DuckDB. Don't use it as a column alias.

## Export format

`web/public/data/` is generated (`uv run python -m znhstry export`) and gitignored -
67 MB, fully rebuildable. Binaries are plain columnar dumps: each column is a contiguous
run of one fixed-width dtype, concatenated in the order `meta.json` lists them, so the
client reads typed-array views over one ArrayBuffer with no decoding library.

A viewer needs `meta.json` + `zones.bin` (1.7 MB) + one checkpoint (~2.4 MB) + one year
of events (~5.3 MB) to render and scrub a year: under 10 MB, before gzip.

Series JSON is **sparse** - only days a value changed. Carry the previous value forward.

## Performance notes

- Query cost is dominated by planning, not transfer. Bigger chunks beat more chunks.
- **Never ask MySQL for point-in-time state.** A `ROW_NUMBER() OVER (PARTITION BY ZoneId)`
  snapshot took 48s for 5,397 zones; pulling the raw event stream for the same zones took
  5.4s and yields every frame, not one.
- Filter inside CTEs, not after — `changelog` is 11.3M rows.
- `BETWEEN` needs the low bound first or it silently returns nothing.

## Conventions

- Extraction is **idempotent**: a chunk whose Parquet exists is skipped. Writes go to a
  `.tmp` then atomically rename, so interruption never leaves a partial file.
- `data/` is gitignored and fully rebuildable.
- Conventional commits: `feat:`, `fix:`, `data:`, `docs:`, `refactor:`.
- Testing is deliberately minimal for now. The one test worth writing when the dbt layer
  exists: `checkpoint(year N) + sum(deltas in year N) == checkpoint(year N+1)` per faction.
