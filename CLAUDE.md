# znhstry (Zone History)

Historical visualization of QONQR zone control: current state, state over time, and
period-over-period change. Public read-only SQL mirror -> Parquet -> dbt/DuckDB -> deck.gl dashboard.

**Slug is `znhstry`; display name is "Zone History".** Use the display name in page titles,
headings, and prose. The slug is for the repo, URL, and package only.

## Tech Stack

- **Python** 3.13+, managed by `uv`. Type hints on functions. Lint with `ruff`.
- **Extract**: `httpx` + `polars` -> Parquet in `data/raw/`.
- **Transform**: dbt-duckdb (not yet built).
- **Web**: Next.js static export + deck.gl, in `web/`.
- **Deploy**: GitHub Pages at `featheranalytics.dev/znhstry` (not wired up yet).

## Commands

```bash
cd pipeline
uv run python -m znhstry all                      # full extraction (idempotent, resumable)
uv run python -m znhstry changelog                # one step: lookups|zones|changelog|baseline
uv run python -m znhstry export --scope global    # rebuild web/public/data (~75s)

cd web
npm run dev                                       # http://localhost:3000
npm run build                                     # static export to web/out
```

**Known local friction:** `npm run build` fails at the very end with
`EBUSY ... rmdir web/out` on this machine. `next build` clears `out/` before writing it,
and `OneDrive.Sync.Service` holds that directory open even when it is empty - killing
node does not release it and neither does `Remove-Item -Force`. Everything before that
step succeeds (compile, type check, all four static pages, build traces), so it is not a
code failure. Pause OneDrive sync to get a real static export locally; CI on Linux never
hits it. `npm run dev` is unaffected and exercises the same code.

## The viewer

Two modes, switched at zoom 4 (`DETAIL_ZOOM` in `app/page.tsx`):

- **Below it**, the map is one cell per tile drawn from `series/tiles*.json.gz`. No zone
  positions, no checkpoints, no event shards - 9 requests, ~1.9 MB, and scrubbing is
  instant because every frame is already in memory.
- **At or above it**, visible tiles' checkpoints and event shards load and the map draws
  individual zones. `zones.bin.gz` (9.87 MB) is prefetched in the background during the
  overview so the first zoom-in does not stall on it; `zone_names.json.gz` (8.2 MB) waits
  until there is a detail view to hover.

Measured: world view 9 requests / 1.9 MB. Zoomed into the north-eastern US, 11 tiles,
68 requests / 21.5 MB total - of which 18.1 MB is zone positions and names, and only
1.7 MB is tiled history.

The stats panel always shows exact whole-scope totals read from `scope_daily`, never a
sum over whichever tiles happen to be loaded, so it is right during a partial load. The
one in-view number is "zones held in view", which says so.

### Boundaries come from polygons, not the boundary-line layers

`boundaries.py` traces **polygon rings**, because Natural Earth's line layers were the
reason the map looked arbitrary:

| | old (lines) | new (polygon rings) |
|---|---|---|
| admin0 | `ne_50m_admin_0_boundary_lines_land`, land borders only — island nations had **no outline at all** | `ne_50m_admin_0_countries`, **242** countries, coasts included |
| admin1 | `ne_50m_admin_1_states_provinces_lines`, 581 features across **9 countries** | `ne_10m_admin_1_states_provinces`, **251** countries |

Rings are simplified with Douglas-Peucker at `SIMPLIFY_TOLERANCE = 0.01` degrees
(~1.1 km), which takes admin1 from 1.30M points to 382k — still far more detailed than
the 50m data it replaces. admin0 is 0.49 MB and loads with the page; admin1 is 2.32 MB
and is marked `deferred` in `boundaries.json`, so it loads on first detail view alongside
the other zoomed-in payloads.

Rebuild with `uv run python -m znhstry boundaries`. That step was previously reachable
only by importing the module by hand.

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
- **`zones.CountryId` is authoritative; `RegionId` is not.** For 447 zones the region's
  own `countryid` contradicts the zone's `CountryId`, and coordinates settle it every
  time in the country's favour: 155 zones the data files under West Pomeranian
  Voivodeship (Poland) sit at 161°E, -10° in the Solomon Islands; 135 filed under
  Northwest Territories (Canada) are at 27°E, -10° in the DRC; likewise Tonga↔Azerbaijan
  (87) and East Timor↔Ukraine (68). The data dictionary documents both join paths as
  equivalent. They are not. Trust `CountryId`, and drop the region label when it
  disagrees rather than printing a contradiction. 417 of these fall in the active scope.
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
  date rather than failing. `_pack` checks bounds before writing.
- **Sort event shards by `observed_at`, never by `activity_date`.** 653,071 zone-days
  carry more than one event, so ordering by the date leaves them tied and DuckDB's
  parallel sort emits them in whatever order it finishes in. Two identical runs produced
  945 differing shards. It is also a correctness bug, not just a churn one: the client
  takes the *last* row in file order as the zone's state for that day, so an arbitrary
  order can surface an earlier observation as the day's outcome. `(zone_id, observed_at)`
  is unique across all 9,869,428 rows, so it is a total order.
- `matched` is a reserved word in DuckDB. Don't use it as a column alias.

## Export format

`uv run python -m znhstry export --scope {dallas-1000mi,global}` writes to
`web/public/data/<scope>/`. Global is the destination; Dallas is a smaller fixture for
developing the viewer. Both use the same code path.

| Scope | Zones | Events | Files | Size |
|---|---|---|---|---|
| global | 1,595,086 | 9.87M | 12,264 | 103.1 MB |

Every `.gz` is a gzip stream over a columnar dump: each column is a contiguous run of one
fixed-width dtype, concatenated in the order `meta.json` lists it. Decompress with the
browser-native `DecompressionStream('gzip')`, then take typed-array views at running
offsets. **No decoding library.** A column marked `delta` holds successive differences;
prefix-sum to recover it.

- **Delta-encoding the index beats quantising the counts.** Sorted index columns become
  runs of small numbers that gzip crushes: 5.7x on a checkpoint vs 3.2x for gzip alone,
  and lossless. Log-quantising counts to uint16 gets 6.6x but costs precision for less.
- **Events group by zone idx, not by global timestamp.** Grouping each zone's trajectory
  is what compresses (4.0x vs 3.1x). The client rebuilds a day index on load. Within a
  zone the tiebreak is `observed_at` - see the bug note above.
- Series JSON is **sparse** - only days a value changed. Carry the previous value forward.
- `zones.bin.gz` excludes the 1.09M zones that have never recorded a bot (`active_only`),
  a 40% cut to the two largest global payloads.
- `zones.bin.gz` carries `latitude, longitude, zone_id, region_id, country_id`. The two
  id columns cost 1.35 MB on 1.6M zones (9.6 -> 11.0 MB) because they gzip into long
  runs: region ids are grouped by country upstream and the file is in zone_id order.
  Names come from `lookups.json.gz` (38 KB, 251 countries + 3,799 regions) rather than
  being repeated 1.6M times. `zoneIdentity()` in `lib/data.ts` resolves them and applies
  the country-wins rule above.

### Tiling

Checkpoints and events shard by web-mercator tile at **zoom 4** as well as by time, so a
viewport downloads only what it can see. Paths are `checkpoints/{year}/{x}-{y}.bin.gz`
and `events/{year}-{month}/{x}-{y}.bin.gz`; `meta.json` lists every tile with its bbox,
so the client intersects the viewport without reimplementing the projection.

127 of the 256 tiles hold any zone. The distribution is extremely skewed - **central
Europe** (`8-5`: Germany 66k, France 47k, Poland 39k) is 19% of zones and 27% of events -
which is exactly why tiling pays: zooming anywhere other than there drops nearly
everything. Europe outweighs the US here because the zone set follows named populated
places, and Europe has far more of them per square kilometre.

| | full history, all shards | files |
|---|---|---|
| untiled (before) | ~64 MB | 187 |
| `8-5` central Europe, the worst case | 13.4 MB | 172 |
| `4-6` eastern US (86,687 of its 91,258 zones) | 7.0 MB | 168 |
| `12-7` | 1.0 MB | 167 |

Tiling costs 5.6% in total size (97.7 -> 103.1 MB): more, smaller gzip streams compress
slightly worse. That is the trade.

- **`idx` is global and stable across tiles, never per-tile.** Tiled shards index into
  one flat client-side array. Renumbering within a tile would break every other shard.
- **Tile assignment derives from lat/lon**, which never change, so a zone's tile is
  stable forever and shards stay immutable.
- **`meta.json` hoists the column schema out of the shards.** With over ten thousand
  entries, repeating the schema per shard would dwarf the manifest. It is also written
  compact rather than indented: 695 KB -> 223 KB (70 KB gzipped over the wire).

### Per-tile series carry both the chart and the low-zoom map

`series/tiles.json.gz` (1.5 MB) plus `series/tiles.{year}.json.gz` (76 KB) hold a sparse
daily faction total for every tile, keyed by tile. Split at the current year so the
immutable past is fetched once and only the small live file churns nightly. One combined
file per half rather than one per tile: the client wants all 127 up front, and 127
requests to assemble 1.5 MB is worse on every axis.

They do two jobs:

1. **The viewport chart** sums the visible tiles. No event shard is touched.
2. **The map below zoom 4** draws one cell per tile straight from this, so a world view
   needs no `zones.bin.gz`, no checkpoint and no event shard at all - 9 requests and
   ~1.9 MB to a scrubable world map.

**Do not rebuild the viewport chart by delta-walking per-zone events.** A per-zone delta
needs every event that zone ever had. Once events are tiled, a zone whose earlier history
sits in a tile the viewer never loaded has no prior value to subtract from, so its first
loaded event books its entire lifetime as one day's change. Summing pre-aggregated tiles
has no such state and is exact: verified against the untiled `scope_daily` series at
max abs difference **0** across 6,059 days.

Only a **single selected zone** still needs a per-event delta walk, and it only ever
reads its own tile's shards.

### Immutability and nightly updates

**`web/public/data/` is currently gitignored, so nothing here is committed yet.** The
choice between committing the export and rebuilding it in CI is still open. Everything
below is written for the committing case, costs nothing under CI rebuild, and is worth
keeping either way because it also makes the export reproducible.

Two rules keep git from bloating, both because **gzip output changes wholesale with its
input, so git cannot delta it** - a rewritten file costs its full size in history every
single night:

1. **Every shard must be immutable once written.** Events shard by *month*, not year, so
   a nightly run rewrites only the current month's tiles. Checkpoints are emitted only
   for boundaries `<= current_date`; a future boundary is really "state as of now" and
   would churn ~4 MB nightly. The client derives current state from the last checkpoint
   plus the event shards after it.
2. **`idx` is a permanent handle, not a row number.** It is assigned once and preserved
   across runs by reading the previous `zones.bin.gz`, which stores `zone_id` per index
   and is therefore its own index manifest. New zones are appended; zones leaving the
   scope stay as tombstones. Without this, any of the 1.09M dormant zones waking up would
   be inserted mid-sequence, renumber everything after it, and invalidate all 103 MB over
   one new zone.

Immutability is only real if the export is **deterministic**, which it was not until the
`observed_at` sort fix above. Check it after any change to shard ordering or contents:

```bash
find web/public/data/global -name '*.gz' -exec md5sum {} + | sort > /tmp/a
cd pipeline && uv run python -m znhstry export --scope global && cd ..
find web/public/data/global -name '*.gz' -exec md5sum {} + | sort | diff /tmp/a -
```

`export_all` clears `checkpoints/`, `events/` and `series/` before writing so a reshard
leaves nothing stale behind. That is safe precisely because immutable shards come back
byte-identical, which git records as no change at all.

`_previous_index` hands the stable index to DuckDB **through a temporary Parquet file**,
not `con.register`. Passing a polars frame directly goes through Arrow and so needs
pyarrow, a large dependency for one handoff; both sides speak Parquet natively.

Still churning nightly and not yet fixed: `series/country_daily.json.gz` (~1.8 MB)
rewrites in full. Shard it by year when it matters. `meta.json` (223 KB) also rewrites,
which is small enough to leave alone.

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
