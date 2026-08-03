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
- Now: [→] Viewer complete and verified. Viewport tiling / LOD is the next phase (see below).
- Next: Next.js + deck.gl viewer against `web/public/data/`
- Remaining:
  - [ ] Region-grain and H3 tile marts (deferred; only global + country built so far)
  - [ ] Nightly incremental GitHub Action + Pages deploy
  - [ ] Decide how generated data reaches Pages: rebuild in CI (90s extract + 30s dbt
        + 5s export) vs committing the 67MB. Leaning CI rebuild, nightly only, so
        deploys don't hammer the Auckland endpoint.

## Next Phase: viewport tiling / LOD  [→ NOT STARTED]

The last substantial piece. Everything else works end to end.

**Problem, measured.** The viewer loads `zones.bin.gz` (9.6MB) + a checkpoint
(~4MB) + event shards regardless of zoom, and viewport/zone chart modes pull
every shard (~60MB, ~190MB resident as typed arrays). Rendering 1.6M points is
*not* the bottleneck -- deck.gl handles that fine. Data volume is.

**Design.**

1. `export.py`: assign each zone a quadkey at z4 (256 tiles; most are empty,
   so expect ~80 populated). Shard `checkpoints/` and `events/` by tile:
   `checkpoints/{year}/{quadkey}.bin.gz`, `events/{year}-{month}/{quadkey}.bin.gz`.
   Keep `zones.bin.gz` whole -- 9.6MB of positions is needed for any view and
   compresses well.
2. `meta.json` gains a `tiles` map: quadkey -> {zone_count, bytes per shard}, so
   the client can skip empty tiles without a request.
3. Client: derive visible quadkeys from `viewportBounds`, fetch only those,
   merge into `ZoneState`. Tiles already loaded stay cached.
4. Zoom LOD: below z3, do not fetch per-zone data at all -- serve a
   pre-aggregated `tiles/{year}-{month}.bin.gz` with per-tile faction totals and
   render one mark per tile. Switch to per-zone above the threshold.

**Watch out for.**

- `idx` is a *global* stable index, not per-tile. Tiled shards must keep storing
  global idx so `ZoneState` stays one flat array. Do not renumber per tile.
- Delta-encoding idx within a tile still works (values ascend within a shard),
  but deltas get much larger. Measure before assuming the 5.7x holds.
- The nightly immutability rule still applies: tiled shards must be immutable
  once written, so tile assignment must be stable. It derives from lat/lon,
  which never change, so this is safe.
- `buildSeries` currently needs *all* events for a correct delta walk. With
  tiles, a zone outside the loaded set has no `last[]` history, so its first
  loaded event would count its whole lifetime as one day. Either keep a
  per-tile `last[]` seeded from that tile's checkpoint, or restrict chart
  viewport mode to loaded tiles and say so in the UI.

That last point is the real trap and the reason to do the export side first
and verify a tile's series against the untiled answer before touching the
client.

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
