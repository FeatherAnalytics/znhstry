# Export format and hosting

## Export format

`uv run python -m znhstry export` writes to `dist/data/global/`, which is gitignored and
uploaded to R2. All zones (played and unplayed), ~10M events, **~2,000 files, ~100 MB**, ~3 minutes with threaded brotli compression.

Stored is not what anyone fetches. Four trees are lazy and together they are 81 of the
94.7 MB:

| Tree | Stored | Fetched |
|---|---|---|
| `zone_history/` | 37.2 MB | one 35 KB block, on a hover |
| `display/` | 25.1 MB | one anchor + one year, ≤ 3.16 MB |
| `names/` | 12.6 MB | one ~19 KB block, on the same hover |
| `series/cells/` | 5.9 MB | the tiles a circle or viewport covers |

`export_all` clears every shard tree before writing, so a layout change cannot leave orphans
behind — otherwise a changed layout strands hundreds of directories and thousands of stale
files that are still served. `upload.py` deletes bucket keys the manifest does not name, for
the same reason, except under `raw/` — see "The raw layer".

Every `.br` is a brotli stream over a columnar dump: each column is a contiguous run of one
fixed-width dtype, concatenated in the order `meta.json` lists it. Served with
`Content-Encoding: br`, so `fetch(...).arrayBuffer()` is already the raw bytes — take
typed-array views at running offsets. **No decoding library.** A column marked `delta` holds
successive differences; prefix-sum to recover it, respecting the dtype.

- **Delta-encoding the index beats quantising the counts.** Sorted index columns become runs
  of small numbers that compress hard: 5.7x vs 3.2x for the container alone, and lossless.
  Log-quantising counts to uint16 gets 6.6x but costs precision for less. `display/` and
  `paint/` *do* quantise, deliberately, because they are display artifacts rather than the
  record. `zone_history/` never does.
- **Rows group by zone idx, not by global timestamp.** Grouping each zone's trajectory is
  what compresses (4.0x vs 3.1x).
- Series are **sparse** — only days a value changed. The binary ones store per-day *deltas*
  and are prefix-summed per area on the client: a delta is a small number that compresses, a
  running total is a seven-digit one that does not.
- A `delta` column may be **signed**. `_pack` only enforces ascending order for unsigned
  dtypes, because the geometry tiles are in spatial order where longitude resets westward at
  every row of latitude. The client's prefix-sum respects the dtype for the same reason —
  restoring a signed column into a `Uint32Array` silently wraps.

### Geometry is tiled, and every zone in a tile is in one file

A 16-degree grid, 168 tiles, all 2,682,442 zones:

| | columns | total |
|---|---|---|
| `tiles/RR_CC.bin.br` | `idx, latitude, longitude` (int32 signed delta), `region_id, country_id` (uint16), `ever_active` (uint8) | 8.53 MB |
| `paint/RR_CC.bin.br` | `pk` (uint8), row-aligned to `tiles/` | 0.73 MB |

**Do not split played zones out of terrain again.** That layout existed so the played
world could paint before the grey arrived, worth about a second, and it cost three
things worth more:

- ~24,000 zones a year are played for the first time and moved between the two files.
  Both changed, both are served `immutable`, and a reader holding a fresh manifest with
  one stale file sees row counts that disagree — which silently erased Ukraine, western
  Russia, India and China from the map.
- Terrain loaded in a second pass, so every grey dot drew on top of every coloured one.
- It was a second file per tile that had to stay row-aligned with `paint/`.

Merged is also *smaller* — 9.26 MB against 9.39 — because splitting a sorted run in two
breaks the delta encoding. `ever_active` is a column so the viewer keeps its two shades
of grey: a zone fought down to empty is part of the story, one never touched is terrain.

This is about the **export**. The viewer does draw terrain as its own deck.gl layer, which
is a different thing and is fine: one file, one fetch, one row count, and the draw order set
explicitly in `ZoneMap` rather than decided by which request finished first.

- **Coordinates are fixed-point at 1e-4 deg (~11 m), delta-encoded, sorted by latitude then
  longitude within a tile.** float32 mantissas are noise and no compressor can touch them.
  1e-3 (111 m) saves ~1 MB but visibly collapses neighbouring zones when zoomed in.
- **Delta-of-delta is 11% worse.** Zones are not on a lattice: longitude gaps within one
  latitude row run 510, 7150, 7700, 340 (units of 1e-4 deg). Don't try it again.
- **16 degrees, not 8 or 4.** Bigger tiles compress better because a smaller one restarts
  every delta run: lat+lon+idx measured 6.88 MB at 2 degrees, 6.04 at 4, 5.56 at 8. The
  reason for 16 is *requests*, though, not bytes. What it costs is precision in the
  nearest-first ordering: the first tile to land covers four times the area.
- **Sorting scrambles idx**, so it is an explicit column rather than implied by row order.

**`pk` is one byte: faction in the top two bits, a log-magnitude bucket in the low six.**
Radius is `log10(count)` capped in pixels, so six bits carry more resolution than the screen
has — 0 is an empty zone, 1..63 are log buckets at eight steps per decade. Six and not eight
so faction and size share a byte, which is what halves `display/`; the resolution given up
moves a dot's radius by about 140 m against a 600–8400 m range.

`paint/` is derived from the *last event per zone*, deliberately not from `dim_zone`'s
`current_*` columns, which come from the `zones` table and disagree with the event stream
for 1,429 zones — taking those would make the map flicker the moment the display stream
answered for today.

### `display/` — the history of what the map draws

| | columns | total |
|---|---|---|
| `display/YYYY.bin.br` | `idx` (uint32 delta), `day` (uint16), `pk` (uint8), ordered `(idx, day)` | 14.9 MB |
| `display/anchor_YYYY.bin.br` | `idx` (uint32 delta), `pk` (uint8), state at 1 Jan, sparse | 10.2 MB |

One row per zone-day that saw **any** event, not only the ones that changed the packed byte.
Anchors carry only zones actually holding something; the client zero-fills first, so an
absent zone is an empty one. There is no anchor for the first year in the record.

15 year shards up to 2.05 MB and 14 anchors up to 1.11 MB — one shard per year from
`RECORD_START`, so 2010's sentinels get neither — and the worst case for landing on any
date is **3.16 MB**.

### `zone_history/` — the exact record, by block of zone index

`zone_history/BBBB.bin.br`, 4096 zones per block, 655 blocks, 37.2 MB, **35 KB median**.
Columns are `idx` (uint32 delta), `day` (uint16), `control_state` (uint8) and the three
counts (int32). Cut by zone rather than by date so a hover fetches one block, not the lot.
Written from **one query over the whole stream, split in Python by a `idx // 4096` block
column** — a query per block scans all 9.88M events 655 times to write 37 MB, and is most
of the export's running time. Prefixing `block` to the `(idx, observed_at)` order changes
nothing, because it is a function of `idx`.

### `names/` — by index block, and off the load path

`names/BBBB.json.br`, 4096 zones per block, 655 blocks, ~19 KB each, 12.6 MB total.
**Row `i` of block `B` is zone `B * 4096 + i`**, placed by idx rather than row position so a
scope that leaves tombstones behind cannot shift them.

Keyed by index, not by tile, so there is no invariant tying a name to the render slot the
client happens to assign — an invisible one whose failure mode was a hover confidently
naming the wrong place. That costs 2.5 MB against tile order, which grouped geographically
similar names together and compressed them better; storage and egress are both free.

Dictionary encoding was tested and is worse (10.05 MB vs 8.0 MB on a 1.6M set): 1.06M of
1.6M names are unique. Region and country names come from `lookups.json.br` (29 KB, 251
countries + 3,799 regions) rather than being repeated per zone; `zoneIdentity()` in
`lib/data.ts` resolves them and applies the country-wins rule above.

`zone_ids.bin.br` is `ZoneId` in idx order, **delta-encoded: 4.21 MB -> 141 KB**, because
idx order *is* zone_id order. It is also the export's index manifest, which is what
`_previous_index` reads to preserve the permanent idx assignment.

### `series/` — precomputed aggregates

`country.bin.br` (0.94 MB) and `region.bin.br` (3.19 MB) carry `area_id` (uint16), `day`
(uint16) and three int32 **deltas**, sorted `(area_id, day)`. `series/cells/RR_CC.bin.br`
shards one-degree cells by the same 16-degree grid, 168 shards, 5.9 MB total — **256 cells
to a tile, and the cell index is a uint8**, where 15*16+15 = 255 is exactly the last value
that fits. A wider tile grid needs a wider column; `export.py` raises if that is ever
violated.

A region row counts only zones whose `country_id` agrees with the region's own — the same
country-wins rule the map applies, so a region contradicted by its zones comes up empty
rather than reaching across an ocean.

`global_daily` and `scope_daily` stay sparse JSON, ~56 KB each.

### `atlantis/` — tournament payloads

`atlantis/index.json.br` carries the tournament list and all-time standings. `atlantis/YYYY-MM.json.br` carries one month's detail: player launch arrays, faction hourly series, and zone count arrays, all positional over an `observations` timestamp list. JSON, brotli-compressed like everything else, ~10 KB total for one month.

Series in the month payload are positional over `observations` with `null` where a player, faction, or zone has no row at that observation. Intervals and per-hour rates are derived on the client from consecutive non-null values and the observation timestamps. Zones are keyed in pyramid order (`Prime`, then `Legion 1`..`6`, `Swarm 1`..`6`, `Faceless 1`..`6`); players sorted by name within each faction; factions in Legion, Swarm, Faceless order. The `battles` block carries per-day per-zone player rows from the battle reports (`fct_atlantis_zone_player_daily`), keyed by date then zone position, each player as `[name, launches, bots_killed, bots_lost]` sorted by rank; the list is capped at 50 per report.

Derived months (source "reports") write one `YYYY-MM.json.br` per month without hourly data: zones as a list ordered by triangle (Central, Legion, Swarm, Faceless) then position then name, and players grouped by attributed faction with `faction_source`, `is_mercenary`, and `qredits_estimate` (null for Unconfirmed). `index.json` carries them in `tournaments_derived` separately from collected entries, with `first_report_date`/`last_report_date` instead of observation timestamps, plus `end_tolerance_days`, `schedule_note`, and `placement_tiebreak`. `all_time` gains `players_derived` and `factions_derived` from non-board months. The tree is cleared and rewritten each run; determinism is verified by the md5 recipe.

### Immutability and nightly updates

`dist/` is gitignored and the nightly run uploads it. A bucket has no history, so git bloat
is not a concern.

1. **Shard names are stable, so `Cache-Control` is what decides correctness.**
   `immutable` is a promise that the bytes at a URL will never change, and the browser holds
   it for the full year without asking again — a hard reload does not override it. Marking a
   shard that churns as immutable means a returning reader keeps yesterday's map.

   **`upload.py`'s `_cache_control` gives one answer for every object: revalidate.** The
   only exception is the `raw/` archive, which no browser fetches.

   That is deliberate, and it replaced a per-tree table that marked positions and finished
   years immutable. Deciding which files "really never change" is exactly the judgement that
   broke the map, and a new shard is added by someone who has not read the table. A 304
   carries no body, so being right costs a header exchange rather than a re-download.

   The ETag skip compares *bodies*, not headers, so changing this policy does not restamp
   objects whose bytes are unchanged. `ZNHSTRY_UPLOAD_FORCE=1` re-sends everything; it is
   only needed after editing `_cache_control`.

   Sharding `display/` by year rather than by month is a deliberate trade: a month grain
   would churn less nightly but make landing on a date cost up to twelve fetches instead of
   one. A nightly run touches roughly the 2,000–3,100 zones with events, scattered across
   `zone_history/` blocks, so expect a slice of that 37.2 MB to churn.

2. **`idx` is a permanent handle, not a row number.** It is assigned once and preserved
   across runs by reading the previous `zone_ids.bin.br`, which stores `zone_id` per index
   and is therefore its own index manifest. New zones are appended; zones leaving the scope
   stay as tombstones. Without this, a new zone would be inserted mid-sequence, renumber
   everything after it, and invalidate the whole export over one row. Copy
   `zone_ids.bin.br` and `meta.json` forward if the output path ever moves.

**`upload_all` skips objects whose ETag already matches.** For a single `put_object` — which
is all of them — R2's ETag is the MD5 of the body, and the bucket listing that finds orphans
already returns it, so the content check is free. Without it a nightly run re-sends all
~1,900 objects and 94 MB including the ~21 MB of positions, names and lookups that change
essentially never. `meta.json` is always sent: it is small, and a client holding a stale one
looks for shards that no longer exist. It also uploads **last**, so a client reading it
always finds every shard it names.

Immutability is only real if the export is **deterministic**. Re-check after any change to
shard ordering or contents:

```bash
find dist/data/global -name '*.br' -exec md5sum {} + | sort > /tmp/a
cd pipeline && uv run python -m znhstry export && cd ..
find dist/data/global -name '*.br' -exec md5sum {} + | sort | diff /tmp/a -
```

`paint/`, the current year's `display/` shard and the touched `zone_history/` blocks will
differ on any run that picks up new events. Nothing else may.

For an atlantis-only change, the recipe scopes to that tree:

```bash
find dist/data/global/atlantis -name '*.br' -o -name '*.json' | sort | xargs md5 -r > /tmp/a
cd pipeline && uv run python -m znhstry export --only atlantis && cd ..
find dist/data/global/atlantis -name '*.br' -o -name '*.json' | sort | xargs md5 -r | diff /tmp/a -
```

The nightly keeps the full export; `--only atlantis` is for decoupled iteration.

`_previous_index` hands the stable index to DuckDB **through a temporary Parquet file**, not
`con.register`. Passing a polars frame directly goes through Arrow and so needs pyarrow, a
large dependency for one handoff; both sides speak Parquet natively.

`series/country.bin.br` and `series/region.bin.br` are written whole, so a nightly run
re-sends 4.1 MB of them.

### Boundaries come from polygons, not the boundary-line layers

`boundaries.py` traces **polygon rings**: `ne_50m_admin_0_countries` gives 242 countries
with coasts included, and `ne_10m_admin_1_states_provinces` gives 251 countries' internal
divisions. The line layers are the wrong source — `ne_50m_admin_0_boundary_lines_land` has
land borders only, so island nations get no outline at all, and the admin1 line layer covers
just 9 countries.

Rings are simplified with Douglas-Peucker at `SIMPLIFY_TOLERANCE = 0.01` degrees (~1.1 km),
which takes admin1 from 1.30M points to 382k. admin0 is 0.32 MB, admin1 is 1.55 MB; both
load with the page. Rebuild with `uv run python -m znhstry boundaries`.

## The raw layer

`data/raw`, ~290 MB, gitignored, and **not rebuildable from upstream** — the ring reaches
back 31 days and the record starts in 2012. R2 holds the only other copy, under `raw/`.

| | Layout | Rows |
|---|---|---|
| `changelog/year=YYYY/events.parquet` | 16 partitions, hive | 9.88M |
| `zones/zones.parquet` | one file | 2,682,442 |
| `battlestats/battlestats.parquet` | one file, 77 columns verbatim | 61,517 |
| `lookups/`, `boundaries/` | | 251 countries, 3,799 regions |

- **Year partitions, because an append should rewrite one file.** The old 88-shard layout
  sized API responses; there is no API to size for. DuckDB prunes on the directory name.
- **`(ZoneId, LastUpdateDateUtc)` is unique across all 9.88M rows**, which is what makes the
  merge keyed rather than appended — so re-reading a slot adds nothing and a retried run is
  free. Never change this to an append.
- **`upload_all` deletes every bucket key the export does not name.** The `raw/` and
  `marts/` prefixes are explicitly excluded, and the archive's own sweep is scoped to
  `raw/` in reverse. Remove either fence and one job silently destroys the other's data.
- **`raw/_manifest.json` is written last by every archive run, and `restore` needs no key.**
  A public bucket cannot be listed, so the manifest — every key under `raw/` with its MD5,
  from a fresh listing after the run — is how a fresh clone or a pull-request runner learns
  what to fetch. Without R2 credentials `restore` reads it over plain HTTP from
  `PUBLIC_DATA_ORIGIN` and refuses any body whose MD5 does not match; a truncated Parquet
  file decodes into plausible rows for however many arrived, and nothing downstream would
  notice. `tests/test_restore_public.py` pins the refusal. Both the nightly and the hourly
  Atlantis job rewrite the manifest, each from a complete listing, so whichever runs last
  leaves it whole.
- **`schema.py` is the dtype contract, not documentation.** Two paths write this Parquet and
  DuckDB reads them through one glob; a column differing in width between them makes the
  source unreadable, not merely inconsistent.

### Reading the warehouse without a key

Two ways in, and neither needs a credential. `uv run python -m znhstry restore` pulls the
raw layer over HTTP from the public bucket through `raw/_manifest.json`, and
`cd transform && uv run dbt build` rebuilds the whole warehouse from it in ~25 s — which is
exactly what CI does on every pull request. Or skip the warehouse: the marts are published
as Parquet under `marts/`, and any DuckDB reads them in place:

```sql
select country_name, total_bots
from read_parquet('https://data.znhstry.com/marts/fct_country_daily.parquet')
where is_latest
order by total_bots desc limit 10;
```

See "The marts, as Parquet" below for every table and its sort key.

A third way in is for an LLM client rather than a person. `mcp/` is a small MCP server that
runs DuckDB over the published Parquet, so it needs no clone, no warehouse and no key:

```bash
uvx --from "git+https://github.com/FeatherAnalytics/znhstry#subdirectory=mcp" znhstry-mcp
```

Four tools — `list_tables`, `describe_table`, `freshness` and `query` — and it is read-only by
construction: one statement per call, admitted only if DuckDB parses it as SELECT or EXPLAIN
(which covers WITH, DESCRIBE, SHOW and SUMMARIZE, with PRAGMA and CALL rejected by name), and
the connection has `disabled_filesystems = 'LocalFileSystem'` under `lock_configuration`, so
SQL cannot touch the host's disk or undo the setting. `allow_persistent_secrets` must be off
before the lockdown: httpfs opens `~/.duckdb/stored_secrets` on its first request, and with the
local filesystem disabled that fails and leaves every later HTTP read broken.
`--http HOST:PORT` serves the same thing over streamable HTTP with `GET /tables` and
`GET /query?sql=` beside it, which is the shape a hosted API would take.

## The marts, as Parquet

`uv run python -m znhstry marts` writes every mart anything outside the map would want as
one zstd Parquet file per table under `dist/marts/`, and `upload --marts` puts them in the
bucket under `marts/`. This is the analytics layer: anything that queries the warehouse
from outside — a notebook, a SQL page, an API — reads these and nothing else. About 3 s to write. Nothing installed and no key:

```sql
select * from read_parquet('https://data.znhstry.com/marts/fct_zone_events.parquet') where country_id = 244;
select * from read_parquet('https://data.znhstry.com/marts/dim_zone.parquet') where country_id = 244;
select * from read_parquet('https://data.znhstry.com/marts/fct_country_daily.parquet') where country_id = 244;
select * from read_parquet('https://data.znhstry.com/marts/fct_global_daily.parquet');
select * from read_parquet('https://data.znhstry.com/marts/fct_zone_battles.parquet') where battle_date >= '2026-01-01';
select * from read_parquet('https://data.znhstry.com/marts/stg_battlestats.parquet') where is_tournament;
select * from read_parquet('https://data.znhstry.com/marts/stg_atlantis_leaderboard.parquet');
select * from read_parquet('https://data.znhstry.com/marts/stg_atlantis_zones.parquet');
select * from read_parquet('https://data.znhstry.com/marts/stg_atlantis_zone_months.parquet');
select * from read_parquet('https://data.znhstry.com/marts/stg_atlantis_tournaments.parquet');
select * from read_parquet('https://data.znhstry.com/marts/fct_atlantis_player_interval.parquet') where tournament_month = '2026-09-01';
select * from read_parquet('https://data.znhstry.com/marts/fct_atlantis_faction_hourly.parquet') where tournament_month = '2026-09-01';
select * from read_parquet('https://data.znhstry.com/marts/fct_atlantis_zone_interval.parquet') where tournament_month = '2026-09-01';
select * from read_parquet('https://data.znhstry.com/marts/dim_atlantis_tournament.parquet');
select * from read_parquet('https://data.znhstry.com/marts/fct_atlantis_payout.parquet') where tournament_month = '2026-09-01';
select * from read_parquet('https://data.znhstry.com/marts/fct_atlantis_zone_player_daily.parquet') where battle_date >= '2026-09-01';
```

| Table | Sorted by |
|---|---|
| `fct_zone_events` | `country_id, observed_at, zone_id` |
| `dim_zone` | `country_id, zone_id` |
| `fct_country_daily` | `country_id, activity_date` |
| `fct_global_daily` | `activity_date` |
| `fct_zone_battles` | `battle_date, battle_report_number` |
| `stg_battlestats` | `battle_date, battle_report_number` |
| `stg_atlantis_leaderboard` | natural key |
| `stg_atlantis_zones` | natural key |
| `stg_atlantis_zone_months` | natural key |
| `stg_atlantis_tournaments` | natural key |
| `fct_atlantis_player_interval` | `tournament_month, faction, player_name, observed_at` |
| `fct_atlantis_faction_hourly` | `tournament_month, faction, observed_at` |
| `fct_atlantis_zone_interval` | `tournament_month, zone, observed_at` |
| `dim_atlantis_tournament` | `tournament_month` |
| `fct_atlantis_payout` | `tournament_month, faction, player_name` |
| `fct_atlantis_zone_player_daily` | `battle_date, battle_report_number, rank, player_name` |

Row counts and byte sizes are in `marts/_meta.json`, which names every table with its path, row count, bytes, sort key and columns, plus `newest_event_date`. Written last, so a reader that finds it finds every file it names.

**`is_latest` is how a reader reaches the newest rows without a subquery.** On
`fct_country_daily` and `fct_global_daily` it is true on the newest day in the record; on
`stg_atlantis_leaderboard` and `stg_atlantis_zones` it is true on the newest pull of each
tournament month, so a finished month marks its final standings and a running one its current
board. Computed in dbt with a window function, so the page, the MCP server and any DuckDB
agree on it. Not on `fct_zone_events` or `dim_zone`.

**The sort key is unique for every table, and the writer refuses one that is not.** A
unique key makes the order total; a total order makes the file deterministic; determinism
is what lets the upload's ETag skip send nothing on a night the warehouse did not change.
A key with ties would re-send hundreds of MB every night, silently. `(country_id,
observed_at)` alone is not unique, which is why `zone_id` closes it. Nulls sort last
explicitly: 108 events belong to zones with no `dim_zone` row, and they land in the final
row group rather than wherever the planner put them. Re-check after any change to a key:

```bash
cd pipeline && uv run python -m znhstry marts && find ../dist/marts -type f -exec md5 -r {} + | sort > /tmp/m
uv run python -m znhstry marts && find ../dist/marts -type f -exec md5 -r {} + | sort | diff /tmp/m -
```

**The sort key is also the pruning key.** Row groups are 100,000 rows — 99 over the event
table — and Parquet keeps min/max per group, so `where country_id = 244` reads one group of
the 99 and, over HTTP, makes range requests for that group alone. `dim_zone` leads with
`country_id` for the same reason, so a country filter prunes both sides of the join.

**HUGEINT is cast to BIGINT on the way out.** `fct_country_daily` and `fct_global_daily`
sum BIGINT columns, which DuckDB types as HUGEINT, and Parquet has no int128 — left alone,
DuckDB writes the column as DOUBLE and a consumer reads bot counts as floats. `_meta.json`
reports the types read back from the file, not the warehouse, so it says BIGINT.

`stg_battlestats` is here because `fct_zone_battles` drops the 15,837 tournament reports it
has nowhere to draw; anything counting reports needs the staging view. The four
`stg_atlantis_*` views are published as they stand.

`upload --marts` lists, sends and sweeps under `marts/` alone, and `upload_all` fences
`marts/` off exactly as it does `raw/`. The export's determinism check,
`_refuse_a_half_written_export` and `meta.json` are untouched; the marts have their own
manifest and their own guard against a half-written tree.

