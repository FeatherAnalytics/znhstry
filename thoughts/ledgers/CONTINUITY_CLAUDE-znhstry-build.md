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
  - [x] Full extraction: 9.87M events, 2.68M zones, 221MB Parquet, ~90s
  - [x] `git init` + initial commit on master
  - [x] dbt project on branch `feat/dbt-models`: 5 staging, 1 intermediate, 5 marts,
        9 tests. Full build 27s, 20/20 pass.
  - [x] Export layer: 146,537 zones, 67MB, 35 files, ~5s. Merged to `main`.
        Primary branch renamed master -> main.
  - [x] Viewer complete and verified (map + scrubber + single linked chart).
  - [x] Zone identity: `zones.bin.gz` carries `region_id` and `country_id`;
        `lookups.json.gz` (38 KB) names them. Hover shows name / region /
        country / ZoneId.
  - [x] Boundaries rebuilt from Natural Earth polygons — admin1 went from
        9 countries to 251, admin0 now includes island nations.
  - [x] Export determinism: `observed_at` sort fix. Verified byte-identical
        across consecutive runs (193 files).
  - [x] **Tiling: built, then reverted.** Lives on `feat/tiled-export`.
        The viewer is back to rendering every zone at every zoom.
        See "Why tiling was reverted" below before proposing it again.
- Now: [→] Untiled viewer restored on `restore/untiled-viewer`, with the zone
      identity, boundary and determinism fixes kept. Not merged to `main`.
- Remaining:
  - [ ] Region-grain and H3 tile marts (deferred; only global + country built so far)
  - [ ] Nightly incremental GitHub Action + Pages deploy
  - [ ] Decide how generated data reaches Pages: rebuild in CI (90s extract + 30s dbt
        + 5s export) vs committing the 103MB. Leaning CI rebuild, nightly only, so
        deploys don't hammer the Auckland endpoint.

## Why tiling was reverted

Tiling sharded checkpoints and events by zoom-4 web-mercator tile and added a
zoom LOD: below zoom 4 the map drew one aggregated cell per tile instead of
individual zones. It worked and the numbers were good — world view dropped from
~21 MB to 1.9 MB, and a zoomed-in viewport pulled 1.7 MB of history instead of
60 MB.

**It was rejected anyway, on look.** The point of this map is 1.6M dots tracing
the world; a 16x16 grid of coloured blocks is cheaper and says less. Performance
was never the complaint. This was a foreseeable trade and it was made without
asking — the risk was noted at design time and proceeded with regardless.

If first paint needs to come down, take it out of `zones.bin.gz` (11.0 MB) and
`zone_names.json.gz` (8.0 MB) — those are the real cost — and keep every zone
on screen.

Branch `feat/tiled-export` holds the full implementation and its measurements
(tile-series sums verified exact against `scope_daily` at max abs diff 0, all
12,263 shards byte-identical across runs) if any of it is ever wanted again.

## Open Questions

- UNCONFIRMED: whether the 2019 collection gap (338k events vs 627k/1.44M either side) is
  upstream missing data or a real lull. Check `../QONQR_zonedata` commit history before
  deciding to annotate vs interpolate.
- Whether display name should be "Zone History" everywhere or slug-only in some surfaces —
  user accepted the split but hasn't seen it rendered.
- First paint is ~21 MB and dominated by `zones.bin.gz` (11.0 MB) +
  `zone_names.json.gz` (8.0 MB), not by history. That is the thing to attack if
  load time matters — **not** by dropping zones from the map. Options not yet
  explored: quantise lat/lon to int16 grid offsets; defer names until first
  hover; split names by first-letter or by country.
- UNCONFIRMED: the zone-identity readout (zID / region / country in StatsPanel and the
  chart subtitle) and the rebuilt boundary layers have **not been seen rendered**. The
  browser tooling disconnected mid-session. Verified instead: types clean, every payload
  serves 200, `zoneIdentity()`'s logic reproduced in Python against the real export
  (Dallas -> Texas / United States / #1529645; 417 bad regions suppressed; 0 zones
  without a country), and both boundary binaries decode to their exact expected byte
  length with valid coordinate ranges. What is unproven is purely the rendering.
  **Boundaries especially**: admin1 went from 581 paths to 8,646 and has never been
  drawn — check it does not read as visual noise at low zoom.
- UNCONFIRMED: `npm run build` cannot complete locally — `OneDrive.Sync.Service`
  holds `web/out` open, so `next build` fails at the final rmdir. Compile, types
  and all four static pages succeed first, so it looks environmental, but a
  real static export has **not** been produced or served yet. Confirm on a
  Linux CI runner (or with OneDrive paused) before trusting the Pages deploy.

Resolved since the last revision:

- Viewport aggregation / LOD: **settled as "do not do it"**. See "Why tiling was
  reverted". Every zone renders at every zoom.
- `zones.CountryId` vs `regions.countryid`: country wins, verified against
  coordinates. Documented in `CLAUDE.md` under Data facts.

## Working Set

- `GitHub/znhstry/pipeline/src/znhstry/` — config.py, api.py, extract.py, export.py,
  boundaries.py
- `GitHub/znhstry/web/` — app/page.tsx, components/ (ZoneMap, HistoryBar, StatsPanel),
  lib/ (data.ts, history.ts, boundaries.ts)
- `GitHub/znhstry/data/` — gitignored Parquet + `znhstry.duckdb`
- `web/public/data/` — gitignored; 194 files, 99 MB, rebuilt by `export`
- Reference: `GitHub/QONQR` (existing current-state map), `GitHub/QONQR_zonedata` (upstream,
  has per-player CSVs not in the DB)
- Dictionary: `Code/QONQR-API-data-dictionary.md`
- **Branches**: `main` still holds the tiled viewer (`2f8b532`) — the version that was
  rejected. `restore/untiled-viewer` is the good one and is NOT merged.
  `feat/tiled-export` keeps the tiling work. Pre-tiling baseline is `416bc76`.
- Run: `cd pipeline && uv run python -m znhstry export --scope global`  (~3 min)
  and `uv run python -m znhstry boundaries` (rarely; network fetch, cached in data/raw)
- `ruff` is in pyproject but not installed in the venv — `uv run ruff` fails
