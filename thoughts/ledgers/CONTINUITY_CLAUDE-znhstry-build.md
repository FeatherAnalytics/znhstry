# Continuity — znhstry build

## Goal

A historical QONQR dashboard: current stats, stats over time, and period-over-period, at
zone / region / country / global / viewport grain. Done = deployed to
`featheranalytics.dev/znhstry` with a scrubable map and linked time series.

## Constraints

- Slug `znhstry`, display name **"Zone History"**.
- Simplicity first. Minimal tests — the user explicitly does not want token spend on test
  scaffolding. Accurate and fast beats comprehensive.
- Upstream API is a shared research box: 3 concurrent max, 0.5s floor, identifying UA.
  Do not raise.
- Stack must match the existing portfolio: uv + polars + dbt-duckdb + Next.js/deck.gl.

## Key Decisions

- **dbt-duckdb over hand-rolled Python transforms** — this is an analytics-engineering
  portfolio piece; lineage and incrementality are the point.
- **Extract globally, not just the Dallas 1000mi slice.** Global/country stats are a stated
  requirement and a scoped pull would need redoing. First *viewer* still scopes to Dallas.
- **Skip the 1.45M pre-2012 sentinel rows** — only 29 carry bots, pulled separately.
- **Adaptive chunking**: yearly to 2019, monthly from 2020. 88 chunks, not 171.
- **Never query point-in-time state server-side** — pull the event stream, fold client/local.
- Aggregates use cumulative-sum-of-deltas; zone-level state uses year checkpoints + deltas.

## State

- Done:
  - [x] Feasibility analysis + API profiling
  - [x] Project scaffold, config, polite API client
  - [x] Extractor (idempotent, resumable, atomic writes)
  - [x] CLAUDE.md + README with measured data facts
- Now: [→] Full extraction running in background (zones + lookups done; changelog ~88 chunks)
- Next: dbt project — staging -> int_zone_events (deltas) -> checkpoints + daily marts
- Remaining:
  - [ ] Export layer: marts -> packed binary (map) + JSON (charts)
  - [ ] Next.js + deck.gl viewer, Dallas 1000mi scope first
  - [ ] Nightly incremental GitHub Action + Pages deploy

## Open Questions

- UNCONFIRMED: whether the 2019 collection gap (338k events vs 627k/1.44M either side) is
  upstream missing data or a real lull. Check `../QONQR_zonedata` commit history before
  deciding to annotate vs interpolate.
- UNCONFIRMED: viewport aggregation approach. Leaning H3 res ~4 pre-aggregated tiles,
  summed in-view, with zone-level detail past a zoom threshold. Not yet designed.
- Whether display name should be "Zone History" everywhere or slug-only in some surfaces —
  user accepted the split but hasn't seen it rendered.

## Working Set

- `GitHub/znhstry/pipeline/src/znhstry/` — config.py, api.py, extract.py, __main__.py
- `GitHub/znhstry/data/raw/` — gitignored Parquet output
- Reference: `GitHub/QONQR` (existing current-state map), `GitHub/QONQR_zonedata` (upstream,
  has per-player CSVs not in the DB)
- Dictionary: `Code/QONQR-API-data-dictionary.md`
- Not a git repo yet — `git init` still pending
- Run: `cd pipeline && uv run python -m znhstry all`
