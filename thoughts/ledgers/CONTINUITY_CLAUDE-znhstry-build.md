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
  - [x] **Tiling, export side.** Branch `feat/tiled-export`, commit `13d1b34`.
        Checkpoints and events shard by zoom-4 web-mercator tile; per-tile
        daily series backs the chart. 12,045 files, 103.1 MB, ~75s.
        All verified — see "Tiling: what was verified" below.
  - [x] **Tiling, client side + zoom LOD.** The viewer runs against the tiled
        layout and is an MVP: world view is 9 requests / 1.9 MB, zoomed-in
        detail loads only the visible tiles. Verified in a browser end to end.
- Now: [→] MVP is working. Next real gap is deployment (see Remaining).
- Remaining:
  - [ ] Region-grain and H3 tile marts (deferred; only global + country built so far)
  - [ ] Nightly incremental GitHub Action + Pages deploy
  - [ ] Decide how generated data reaches Pages: rebuild in CI (90s extract + 30s dbt
        + 5s export) vs committing the 103MB. Leaning CI rebuild, nightly only, so
        deploys don't hammer the Auckland endpoint.

## Tiling: what was verified  [export side DONE]

Format details live in `CLAUDE.md` under "Export format". Not repeated here.

**The trap, and how it was avoided.** The original design flagged `buildSeries`
as the real risk: a per-zone delta walk needs every event a zone ever had, so a
zone whose history sits in an unloaded tile books its whole lifetime as one
day's change. The chosen fix was *not* the fallback in the old plan (restrict
the chart to loaded tiles). It is a pre-aggregated **per-tile daily series** the
viewport chart sums instead. Stateless, exact, ~80 KB per tile, four fetches.

**Verified, all against the untiled answers:**

1. Sum of all 127 per-tile series vs `scope_daily` — max abs diff **0** across
   6,059 days and all three factions.
2. Checkpoint 2020 reassembled from 127 tile shards and decoded — **identical**
   to the DB across all 1,310,342 rows, so delta-encoded `idx` survives the split.
3. Event rows: **9,869,320 tiled == 9,869,320 in DB**, no row lost or duplicated.
4. Two consecutive exports — **all 12,263 shards byte-identical**. This did not
   hold before the `observed_at` sort fix.

**Cost of tiling:** 97.7 -> 103.1 MB (+5.6%), 187 -> 12,264 files. More, smaller
gzip streams compress slightly worse. Delta-encoded `idx` still pays off despite
larger within-tile gaps — 5.3x overall vs raw.

**Client side: done.** Two modes split at `DETAIL_ZOOM = 4` in `app/page.tsx`.
Details in `CLAUDE.md` under "The viewer". Measured in a real browser:

| view | requests | bytes |
|---|---|---|
| world (overview) | 9 | 1.9 MB |
| zoomed to NE US, 11 tiles | 68 | 21.5 MB (18.1 of it zone positions + names) |

Checked working: overview scrub, zoom into detail, per-zone colouring, viewport
chart mode ("11 of 127 tiles"), scrub back to 2013 across an early checkpoint
(282 zones held, 8.7M bots — correct for the early record), no console errors.

The low-zoom LOD reuses the per-tile *series* rather than a new per-frame map
payload, so the once-planned `tiles/{year}-{month}.bin.gz` was never needed.

## Open Questions

- UNCONFIRMED: whether the 2019 collection gap (338k events vs 627k/1.44M either side) is
  upstream missing data or a real lull. Check `../QONQR_zonedata` commit history before
  deciding to annotate vs interpolate.
- Whether display name should be "Zone History" everywhere or slug-only in some surfaces —
  user accepted the split but hasn't seen it rendered.
- `zones.bin.gz` (9.87 MB) + `zone_names.json.gz` (8.2 MB) are now the dominant
  cost of the detail view — 18.1 MB against 1.7 MB of actual tiled history.
  Both are deferred out of the world view, so they no longer block first paint,
  but they are the obvious next optimisation. Splitting them by tile would
  complicate `idx` recovery, since `zones.bin.gz` is also the index manifest.
- UNCONFIRMED: `npm run build` cannot complete locally — `OneDrive.Sync.Service`
  holds `web/out` open, so `next build` fails at the final rmdir. Compile, types
  and all four static pages succeed first, so it looks environmental, but a
  real static export has **not** been produced or served yet. Confirm on a
  Linux CI runner (or with OneDrive paused) before trusting the Pages deploy.

Resolved since the last revision:

- Viewport aggregation is settled: web-mercator z4, not H3. Chosen because the
  client already thinks in mercator tiles and needs no projection library.

## Working Set

- `GitHub/znhstry/pipeline/src/znhstry/` — config.py, api.py, extract.py, export.py
- `GitHub/znhstry/web/` — app/page.tsx (mode orchestration), components/
  (ZoneMap, HistoryBar, StatsPanel), lib/ (data.ts, history.ts, boundaries.ts)
- `GitHub/znhstry/data/` — gitignored Parquet + `znhstry.duckdb`
- `web/public/data/` — gitignored; 12,264 files, 103 MB, rebuilt by `export`
- Reference: `GitHub/QONQR` (existing current-state map), `GitHub/QONQR_zonedata` (upstream,
  has per-player CSVs not in the DB)
- Dictionary: `Code/QONQR-API-data-dictionary.md`
- Branch: `feat/tiled-export`, one commit ahead of `main` (`13d1b34`), not merged
- Run: `cd pipeline && uv run python -m znhstry export --scope global`  (~75s)
- `ruff` is in pyproject but not installed in the venv — `uv run ruff` fails
