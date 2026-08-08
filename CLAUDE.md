# znhstry (Zone History)

Historical visualization of QONQR zone control: where every zone stands, what moved over
any window, and how the whole thing got here. QONQR's published CSV drop -> Parquet ->
dbt/DuckDB -> deck.gl dashboard.

**Slug is `znhstry`; display name is "Zone History".** Use the display name in page titles,
headings, and prose. The slug is for the repo, URL, and package only.

**This repo is self-contained.** It reads QONQR's own published data and nothing else — no
third-party mirror, no other repository, no server that belongs to a person rather than the
game. See "Where the data comes from".

## Tech Stack

- **Python** 3.13+, managed by `uv`. Type hints on functions. Lint with `ruff`.
- **Ingest**: `httpx` + `polars` -> Parquet in `data/raw/`.
- **Transform**: dbt-duckdb in `transform/` — 6 staging views, 1 intermediate, 6 marts,
  1 seed, 12 data tests, 1 unit test, 2 exposures. `uv run dbt build` takes ~25 s over
  9.88M events.
- **Export**: `pipeline/` slices the marts into static binaries under `dist/data/global/`.
- **Web**: Next.js static export + deck.gl, in `web/`.
- **Hosting**: the site on GitHub Pages, the data in Cloudflare R2. Two deployments.

## Commands

The refresh chain is four steps and they are not optional — exporting without rebuilding
the warehouse ships whatever the marts last held:

```bash
cd pipeline  && uv run python -m znhstry ingest    # read the day's slot from Dropbox
cd transform && uv run dbt build                   # rebuild the marts (~25 s)
cd pipeline  && uv run python -m znhstry export    # rebuild dist/data (~26 min)
cd pipeline  && uv run python -m znhstry upload    # push changed objects to R2
cd pipeline  && uv run python -m znhstry archive   # push data/raw to R2 under raw/
```

Other steps:

```bash
cd pipeline
uv run python -m znhstry restore          # pull data/raw back from R2 — first step on a clone
uv run python -m znhstry ingest --slots 7 # force specific ring slots (day of month)
uv run python -m znhstry boundaries       # rebuild the admin outlines

cd web
npm run data   # serve dist/data on :3002 — the map is empty without it
npm run dev    # http://localhost:3000
npm run build  # static export to web/out
```

`global` is the only scope. `_create_scope` still implements a haversine radius filter and
`Scope` still carries `lat`/`lon`/`radius_km`, but nothing sets them.

### Local development

`npm run dev` talks to `npm run data` on :3002. `next.config.ts` prefers localhost in
development regardless of what the root `.env` says, because `.env` names the *bucket* —
which is what a production build and `upload.py` need, and exactly wrong for dev. A shell
variable still beats both, so `NEXT_PUBLIC_DATA_ORIGIN=https://… npm run dev` checks the
real bucket. The resolved value is written back into `process.env`: Next inlines
`NEXT_PUBLIC_*` from there, so setting only the `env:` block does nothing.

Configuration lives in one gitignored `.env` at the repo root; `.env.example` documents
every key. Both consumers read it — `next.config.ts` via `process.loadEnvFile`, and
`upload.py` from the environment. CI passes the same names as repository variables and
secrets and never writes a file.

Three things that will cost you an hour if you do not know them:

- **A `next dev` that cannot bind port 3000 moves silently.** It prints
  `Port 3000 is in use … using available port 3003 instead` and carries on, so a browser
  at :3000 keeps talking to the *old* server with the old config compiled in. If a change
  seems not to take effect, check which port it actually bound to.
  `Get-NetTCPConnection -State Listen -LocalPort 3000` names the holder.
- **`Cache-Control: immutable` means the browser will not revalidate, ever** — a hard
  reload does not override it. `tools/serve-data.mjs` therefore sends `no-cache` by
  default, with `SERVE_IMMUTABLE=1` to test the production headers. Any entry cached under
  the immutable header stays stale for a year; clear site data once to be rid of it.
- **`npm run build` fails at `EBUSY … rmdir web/out` on this machine.** `next build`
  clears `out/` before writing it and `OneDrive.Sync.Service` holds the directory open.
  Everything before that step succeeds. Pause OneDrive sync for a real local export; CI on
  Linux never hits it.

## The viewer

**Every zone, at every zoom.** The map draws all **2,682,442** zones as individual points,
including the 1,087,356 that have never held a bot.

### The client never holds the event stream

This is the single most important fact about the viewer. **The browser downloads no
per-zone bot counts at all.** Three questions, three answers, none of which need it:

| Question | Answered by |
|---|---|
| what colour and size is every dot on date D | `display/`, one byte per zone-day |
| how many bots in this country / region / area over time | precomputed daily series |
| exactly how many bots on *this* zone | `zone_history/`, one 35 KB block, on hover |

A cold load is **422 requests and 11.6 MB**, and that is everything needed to draw all
2.68M zones:

| Pass | Gives | Requests | Size |
|---|---|---|---|
| `tiles/` + `paint/` | the played world, positions and colours together, nearest first | 336 | 5.85 MB |
| `terrain/` | the 1.09M zones never played. Always grey | 79 | 3.55 MB |
| boundaries, manifest, ids, lookups, scope series | | 7 | 2.24 MB |

Fetched only on demand, and never by a visit that just looks at the map:

| | When | Size |
|---|---|---|
| `display/` anchor + year | a date other than the one on screen | ≤ 3.16 MB |
| `names/` block | the pointer stops on a dot | ~19 KB |
| `zone_history/` block | the same hover, for exact counts | ~35 KB |
| `series/cells/` | a circle or viewport chart | a few tiles |

**The map is complete and correct after the first pass**, with no history fetched at all.
`paint/` is one byte per zone — faction in the top two bits, a log bucket for size in the
low six — and it is exactly the byte `display/` stores, so nothing converts between two
representations.

Fast 4G, cold cache, from navigation, on a dev build (which puts an unminified Next bundle
in front of everything; production is a fraction of that):

| | |
|---|---|
| played world complete — all 1.6M, correctly coloured | **3.3 s** |
| every zone including terrain — 2.68M | **8.4 s** |
| scrub across eleven years, nothing cached | **526 ms** |

Priority order between passes is load-bearing. `display/` is not touched until the reader
asks for a date `paint/` cannot answer: 3 MB in front of the tiles they are watching
arrive stretched the world from 11 s to 44 s when measured.

### Requests are the binding constraint, not bytes

The data is served from an `r2.dev` URL with no CDN. R2 egress is free and 94.7 MB of
storage is nothing, so **cost is not the issue** — `r2.dev` being rate-limited and
documented as unsuitable for production traffic is. That is why the tile grid is 16 degrees
and names are off the load path.

A custom domain on Cloudflare would put a CDN in front, so most requests never reach R2 and
the constraint disappears.

### One row of controls

Mutually exclusive choices, not a window plus a mode toggle:

- **Current** — where things stand now. Every zone holding bots, sized by how many, on the
  newest date in the record. No window involved.
- **Day / Week / Month / Quarter / Year / All time** — only the zones that saw activity in
  that span. Everything else is hidden outright, not dimmed.

**Day is the default.** It is the liveliest honest view — 2,000–3,100 zones, yesterday's
fighting — and it is what the map is for.

Current and the windows are peers because they are different questions, not modifiers of
one another. A window paired with a "show everything" mode makes half the combinations
duplicates and implies the window means something it doesn't.

**The playhead skips the day still in progress.** A window ending mid-day undercounts for a
reason that has nothing to do with the game, so every window opens on the newest *finished*
day. `Current` goes to the newest date instead, because a level is correct at any moment
and only a window is sensitive to a partial day. `lastCompleteDay()` treats only the
current UTC date as unfinished, so a stale export whose newest day is a week old is left
alone.

**"Moved" means the zone had an event in the window**, not that it crossed a size bucket.
No second state is built to answer it — it is a question about whether rows exist, and
`display/` carries a row for every zone-day with an event precisely so the answer is exact.
That costs ~2 MB across the record against emitting only rows where the packed byte
changed, and it is worth it: at eight buckets per decade a bucket spans a 33% change in bot
count, so a bucket comparison would hide every skirmish smaller than a third of a garrison.

A window's first frame paints everything from `paint/` and applies the filter when the
display data lands. `ZoneDisplay.visible` starts all-ones, so the map is never blank
waiting on 3.6 MB.

### Colour

**A dot's colour is the faction with the most bots standing in that zone on the snapshot
date.** The view only ever decides which dots are drawn.

Not `control_state`, which names whoever captured the zone last and keeps naming them long
after their last bot is gone. The two agree almost perfectly — across all 9.88M events they
differ for 50 events across 43 zones, because in QONQR control follows the garrison — but
the rule is written the honest way so it stays right if that changes. On a tie the holder
breaks it, and only when the holder is one of the tied factions; otherwise a fixed order
does.

Never colour by *which faction gained most* over a window. That is a delta, it makes the
colour mean two different things depending on the view, and one meaning is all a map whose
entire vocabulary is three faction colours can carry.

### Empty zones are a toggle, and it is off

A zone holding no bots is drawn only when "Empty zones" is on. Off by default: the 1.09M
never played plus everything fought down to nothing is most of the map, and two million
grey dots drown the ones being fought over.

**Empty zones answer to the toggle alone, never to the window.** "This zone holds
nothing" is a fact about now, not about the span, so hiding an empty zone because it did
not happen to move this week answers a question nobody asked. Zones that *do* hold
something answer to the window. So a Day window with the toggle on is the day's fighting
in colour over the whole world in grey, which is what makes it readable.

It is a render-time test in `ZoneMap`, not a data one; nothing refetches.

**Picking must apply the same tests as drawing.** deck.gl picks by geometry, and a zone
hidden by a window or by this toggle is still there — drawn at zero alpha and zero radius,
which the picking pass does not care about. `ZoneMap`'s `picked()` repeats both checks, or
hovering empty space confidently describes a zone the reader cannot see. Any new reason to
hide a zone has to be added in both places.

### Focus: an area, a location, or one zone

Two masks, and they are deliberately different:

- **`mapFilter`** — a picked area or near-me. What the map dims by. Zones outside it stay
  on the map at alpha 26; a quarter opacity was not enough, because two million faint dots
  still read as a wash of colour.
- **`filter`** — the same mask plus the clicked zone. What the readouts count.

**Clicking a dot never changes the map.** It is a request to read about that zone, not to
empty the world; folding a selection into `mapFilter` dims all 2.68M other zones, which at
world zoom is indistinguishable from them disappearing.

**The panel's bot counts come from the same series the chart draws**, not from summing the
map, so the two agree by construction. Which series depends on the selection, and only one
is approximate:

| Selection | Source | Exact? |
|---|---|---|
| whole scope | `series/scope_daily.json.br` | yes |
| a country | `series/country.bin.br` | yes |
| a region | `series/region.bin.br` | yes |
| one zone | `zone_history/` block | yes |
| near me, or the viewport | `series/cells/` at one degree | to the nearest cell |

Zone *counts* are exact for every selection, because they are counted off the map's own
bytes. Only the bot-count time series for a circle or viewport is aggregated, since no
export can name an arbitrary circle in advance; the chart's subtitle says "to the nearest
degree" when it is.

**The panel keeps three counts apart and mixing them up is how it starts lying.** `count`
is zones in the selection and is the denominator — deliberately not "zones drawn", because
with empty zones off that would read "1.6M of 1.6M occupied". `held` is zones with bots on
the ground, never the control flag. `drawn` is what the view is showing, which is what
"moved" means.

Other behaviour worth keeping:

- **Geolocation is asked for on a click, never on load.** A prompt before the reader has
  seen the page gets reflexively denied, and a denial is sticky. The `timeout` option does
  not cover the permission dialog — the spec starts its clock only after permission is
  granted — so there is a separate 20 s guard, or the button says "Locating…" forever.
- The area picker counts zones from the geometry actually loaded, and only while it is
  open. A region counts only zones whose `country_id` agrees with it, so a region
  contradicted by its zones comes up empty rather than being reassigned.
- **Percentages against a near-zero baseline are meaningless.** The game started at almost
  no bots, so growth over a long range runs to eight figures of percent. Past tenfold it
  shows as a multiple; past a hundredfold, not at all.

### There is a real basemap under the dots

CARTO's `dark_all` raster tiles, via a deck.gl `TileLayer`. No API key, and it is drawn
dark precisely so data sits on top rather than fighting it.

Admin borders are not orientation. With the basemap you get coastlines, water, roads and
place names at every zoom: at zoom 10 over Rhode Island you can read Providence, Pawtucket,
Cranston and Narragansett Bay.

- **Attribution is a licence condition, not decoration.** `© OpenStreetMap · CARTO` renders
  bottom-right wherever those tiles do. Do not remove it.
- **Our own boundary rings fade out above zoom 5 and are gone by 7.** They are simplified
  to 0.01 degrees (~1.1 km), which is invisible at world zoom and plainly wrong at city
  zoom, where a coastline becomes straight lines cutting across a bay. The basemap's own
  borders are more accurate and sufficient by then. The graticule is dimmed for the same
  reason: two grids fight each other.

Tiles are third-party requests, roughly a dozen per view, cached by the browser normally.

### Do not reintroduce a zoom-based LOD

Below zoom 4 the map once drew one aggregated cell per web-mercator tile instead of
individual zones. It was rejected, and the reason is not performance — **the point of this
map is the millions of dots tracing the world**. A 16x16 grid of coloured blocks is cheaper
and says less.

Spatial **sharding** is a different thing and is what the viewer does: every zone is in
exactly one tile, every tile is eventually fetched, nothing is ever aggregated. The grid
only buys an order.

### Two index spaces, and the bug waiting in them

- `idx` — the export's permanent handle. `display/`, `zone_history/`, `names/` and every
  anchor are keyed by it. Stable across nightly runs.
- `slot` — a zone's position in the render buffer, assigned in tile *arrival* order.
  Meaningless outside a session. deck.gl picks return it.

`slotToIdx` / `idxToSlot` in `lib/geometry.ts` convert. Anything touching game state wants
idx; anything touching a GPU buffer wants slot.

### Every date is a full rebuild, in a worker

`lib/displayWorker.ts` owns the display state. A request zeroes the buffer, applies the
anchor for the target year, then applies that year's rows up to the target day — about
1.6M plus at most 1.4M writes, a few milliseconds — and transfers the filled buffers back.

**Scrubbing backwards costs exactly what scrubbing forwards costs**, so there is no
incremental fast path, no by-day index, and no rule about which direction is cheap. One
byte per zone-day is what makes a rebuild affordable enough to delete all of that.

Buffers are lent to the worker and returned rather than reallocated: playback asks eight
times a second and each `pk`/`visible` pair is 5.4 MB.

Playback is paced by the clock, not by ticks. A step costs 2.7M dots re-coloured plus a
buffer upload, and a fixed days-per-tick would make the run last anywhere from 20 s to a
minute depending on the machine.

### Serve it with `Content-Encoding: br`

Every payload is stored brotli-compressed and served with `Content-Encoding: br`, so the
browser decompresses it and **the client carries no decoding code at all** — a plain
`fetch(...).arrayBuffer()`. `DecompressionStream` has no brotli, so this only works because
the *host* sets the header. GitHub Pages cannot, which is why `dist/data` goes to R2 while
the site keeps the Pages deploy.

Measured against gzip -6: geometry 10.44 MB -> 8.53 (18%), names 11.81 -> 10.10 (15%),
boundaries 2.80 -> 1.83 (35%).

Two brotli qualities, because the curve has a knee. On a 26.9 MB payload: q9 3.93 MB in
4.5 s, **q10 3.60 MB in 46 s**, **q11 3.43 MB in 130 s**. q11 for anything on the critical
path, q10 for the bulk trees — 4% of the ratio for most of the export's running time.

## Where the data comes from

QONQR publishes its own data to a public Dropbox folder. That is the only live source.
Link list: `pipeline/src/znhstry/dropbox_links.txt`. Full data dictionary:
`QONQR-API-data-dictionary.md` in the Code root.

| | What | Cadence |
|---|---|---|
| `dailyzoneupdates-NN.csv` | every zone that changed that day, 31-slot ring | daily |
| `Countries.csv`, `Regions.csv` | lookups | rarely |
| `portal.qonqr.com` | battle reports, one HTML page per report | not yet collected by us |

**Slot `NN` is the day of the month and QONQR overwrites it in place.** Nothing in the
filename says which month, so a stale slot is indistinguishable from a fresh one until it
is parsed — slot 03 holding July while slot 01 holds August is the normal resting state in
the first days of a month, not a fault.

**The dump is written just after midnight UTC, so slot `NN` holds all of day `NN` plus the
first seconds of day `NN+1`.** That sliver is load-bearing: it is the only proof that day
`NN` was read completely. `plan_slots` treats a day as finished only when events *after* it
are on disk, because a max date of `NN` alone means slot `NN-1` was the last one read and
`NN` is still a fragment.

**A gap wider than 31 days is permanent.** The slot holding that day has been overwritten
with a newer month. `plan_slots` raises rather than fetching it and appending the wrong
month's events under a successful exit code. Restore from R2 instead.

**Dropbox needs `?dl=1` and answers no freshness question.** Without it you get an HTML
interstitial with a 200 status, which is why `_download` checks the body starts with a
known header rather than trusting the status. There is no `Last-Modified` on the response
and no year in the filename, so "has today landed" costs a full fetch and parse — which is
why the nightly runs once on a timer instead of polling.

### The SQL mirror, and why it is gone

`neon-ninja/QONQR_zonedata` runs `update.sh` on a cron, loading these same CSVs into an
append-only MySQL `changelog` exposed at `api-proxy.auckland-cer.cloud.edu.au`. Everything
here was originally read through it.

It was only ever an accumulation of the files above, verified before the cutover: over a
full ring, 83,870 events on both sides, no row present in one and absent from the other,
and no differing value on control state or any count. So reading it added a dependency
without adding data.

Do not reintroduce it, and note that their git history is not a fallback either — they
force-push, so a shallow clone cannot even pull. `extract.py` and `api.py` remain only as
a verification oracle and are on no scheduled path.

## Data facts (measured, not guessed)

- **The record starts at release, 2012-07-30.** `config.RECORD_START`. Everything before
  it is pre-release testing — 11 scattered events from 2012-05-19 to 07-29, plus the 29
  backfill sentinel rows dated 2010-01-01 — so "All time" means the life of the game
  rather than the life of the table. The cut is one `zone_events` view that every export
  query reads instead of `fct_zone_events`; there are 12 such queries and filtering each
  would drift. The warehouse keeps the full record, so this is reversible.
  Cost: 40 events across 40 zones, 7 of which stop counting as ever-played.
- **`changelog` is a sparse event stream.** A row exists only when a zone's counts or
  control state changed. 9.88M real events, ~2,000–3,100 a day.
- **Carry-forward is the core modelling problem.** 504,410 zones (32% of those ever active)
  last changed in 2019 or earlier. Any time-window slice that ignores older events loses
  their state entirely.
- **Pre-2012 rows are backfill sentinels.** 1,449,170 of them, of which only **29** carry
  any bots. Everything else is genuinely zero, so pre-first-event state is treated as zero.
  Those 29 live in `changelog/year=2010/` and are the whole of the starting state.
- **2019's gap is a collection artifact, and battlestats proves it**: 337,859 events vs
  627,035 in 2018 and 1,438,855 in 2020 — but **3,614 battle reports in 2019**, flat against
  every neighbouring year. A second, independent source says the game was busy and the
  collection was not. Annotate the gap in any continuous time series; never interpolate it.
- **Only 1,595,086 of 2,682,442 zones have ever changed.** The rest are real places that
  have never been played, and the viewer draws them as faint grey terrain, so the export
  carries all of them (`active_only = False`). They ride in the geometry tiles and never
  appear in the display stream or an event shard.
- **`zones.*Delta` columns are useless to us** — they span the gap between the two most
  recent observations, which may be years. We recompute deltas from `changelog`.
  `TotalDelta` is also absolute (churn), never negative. Not extracted.
- **`Description` is not unique** — many zones share a name. `ZoneId` is the only key.
- **`zones.CountryId` is authoritative; `RegionId` is not.** For 447 zones the region's own
  `countryid` contradicts the zone's `CountryId`, and coordinates settle it every time in
  the country's favour: 155 zones filed under West Pomeranian Voivodeship (Poland) sit at
  161°E, -10° in the Solomon Islands; 135 filed under Northwest Territories (Canada) are at
  27°E, -10° in the DRC; likewise Tonga↔Azerbaijan (87) and East Timor↔Ukraine (68). The
  data dictionary documents both join paths as equivalent. They are not. Trust `CountryId`,
  and drop the region label when it disagrees rather than printing a contradiction.
- **`battlestats` column names contain spaces** and need backticks.
  `Country = 'Atlantis'` marks test/tutorial zones — exclude.
- **Battlestats is a daily leaderboard, not a log of every fight.** QONQR publishes a fixed
  number of reports a day from its Most Active Zones page: exactly 10 on 3,451 of the 4,598
  covered days, 27–29 on most of the rest. A row means *this zone was among the most active
  in the world that day* — never relabel it "battles that day", which would imply the other
  ~3,000 active zones were quiet. No zone is reported twice in a day, so battle grain and
  zone-day grain coincide. Coverage starts 2014-01-01, eighteen months after release.
- Per-player data (`battlestats_players.csv`, `player_details.csv`) exists only in the
  community scrape and is not collected here.

### changelog does not perfectly reconcile to zones

Cumulative deltas from `changelog` land ~0.004% above the `zones` table. The gap decomposes
exactly, with no remainder:

| Faction | Total gap | 3 orphan zones | 1,429 divergent zones |
|---|---|---|---|
| Legion | 441,292 | 0 | 441,292 |
| Swarm | 1,070,874 | 722,697 | 348,177 |
| Faceless | 160,730 | 0 | 160,730 |

- **3 orphan zones** (`2836390`, `2836391`, `2836392`) exist in `changelog` but not in
  `zones`. They land in `fct_zone_events` with a null `country_id`, so they count toward
  `fct_global_daily` but not `fct_country_daily`. Do not "fix" this by inner-joining.
- **1,429 zones (0.09%)** have a last event that disagrees with their `zones` row, always
  with the event higher. Both come from the same daily CSV now, so this is the game's own
  drift rather than a mirror's two-step import, and it is expected to persist.

0.004% of bots is immaterial for a visualization. It is documented rather than tested
against a threshold, because thresholds on upstream drift are brittle.

### Bugs worth not reintroducing

- **Never mistake a day's first sliver for the whole day.** A slot spans midnight, so
  having events *dated* day D usually means slot D-1 was read and D is a fragment. Deciding
  completeness by comparing dates skips D forever. `plan_slots` requires events strictly
  after D, and `tests/test_ingest.py` pins it. This is the same class of bug that used to
  freeze an unfinished extraction window: never assume a thin final day is real.
- **`fct_zone_checkpoints` must compare timestamps, not dates.** Casting to date drops every
  boundary an event lands on — the preceding event fails `next > B` and the event itself
  fails `B > observed`, so no row matches. This silently lost 19,062 checkpoints.
  `tests/assert_one_checkpoint_per_zone_boundary.sql` guards it.
- **Join regions on `region_id` *and* `country_id`.** On `region_id` alone, 447 zones came
  out labelled "Solomon Islands / West Pomeranian Voivodeship". `dim_zone` matches both, so
  a contradicted region is null rather than wrong, and
  `tests/assert_region_label_agrees_with_country.sql` fails if it returns.
- **Do not hardcode a max ZoneId.** New zones appear above the previous maximum. Ingest
  discovers them because they arrive in the daily CSVs like any other change.
- **A bbox prefilter must never be tighter than the circle it precedes.** 111.32 km per
  degree of latitude is a mid-latitude average; a real degree is shorter, so an unpadded box
  is narrower than its radius and clips edge zones before haversine runs.
  `_BBOX_MARGIN = 1.05` in `export.py`.
- **Guard packed integer columns for overflow and sign.** `day` is a uint16 offset from
  `DAY_EPOCH` (2010-01-01, chosen so the 29 backfill sentinel rows are not negative); an
  earlier row would underflow into a plausible-looking date rather than failing. `_pack`
  checks bounds before writing.
- **Sort by `observed_at`, never by `activity_date`.** 653,071 zone-days carry more than one
  event, so ordering by the date leaves them tied and DuckDB's parallel sort emits them in
  whatever order it finishes in. That is a correctness bug as well as a churn one: the
  client takes the *last* row in file order as the zone's state for that day, so an
  arbitrary order can surface an earlier observation as the day's outcome.
  `(zone_id, observed_at)` is unique across all 9.88M rows, so it is a total order.
- **Count zones held by bots on the ground, not by `control_state`.** A zone keeps its last
  holder in that column long after the last bot has gone, so counting the flag reports every
  zone ever captured as currently held — "1.6M of 1.6M", a number that never moves.
- **`serve-data.mjs` must check `isFile()`, not just that `stat` succeeded.** A directory
  stats happily and then `createReadStream` throws EISDIR asynchronously, which killed the
  whole dev server and every tile in flight with it.
- `matched` is a reserved word in DuckDB. Don't use it as a column alias.

## Export format

`uv run python -m znhstry export` writes to `dist/data/global/`, which is gitignored and
uploaded to R2. 2,682,442 zones (1,595,086 ever played), 9.88M events, **1,932 files,
94.7 MB**, ~26 minutes.

Stored is not what anyone fetches. Four trees are lazy and together they are 81 of the
94.7 MB:

| Tree | Stored | Fetched |
|---|---|---|
| `zone_history/` | 37.2 MB | one 35 KB block, on a hover |
| `display/` | 25.1 MB | one anchor + one year, ≤ 3.16 MB |
| `names/` | 12.6 MB | one ~19 KB block, on the same hover |
| `series/cells/` | 5.9 MB | the tiles a circle or viewport covers |

`export_all` clears every shard tree before writing, so a layout change cannot leave orphans
behind. This is not hypothetical: switching layouts once left 187 orphaned directories and
~12,000 stale files still being served. `upload.py` deletes bucket keys the manifest no
longer names, for the same reason.

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

### Geometry is tiled, and split by whether anyone has ever played there

A 16-degree grid, 168 populated tiles (79 of which also have terrain):

| | columns | for all 2.68M |
|---|---|---|
| `tiles/RR_CC.bin.br` | `idx, latitude, longitude` (int32 signed delta), `region_id, country_id` (uint16) — played zones only | 5.12 MB |
| `paint/RR_CC.bin.br` | `pk` (uint8), row-aligned to `tiles/` | 0.73 MB |
| `terrain/RR_CC.bin.br` | same columns as `tiles/`, for zones never played | 3.55 MB |

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
- **The played/terrain split costs ~1.3 MB** of idx compression, because the two files
  interleave and the runs break. It buys a smaller first paint, so it pays.

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

16 year shards running 0.7–2.05 MB and 15 anchors up to 1.11 MB, so the worst case for
landing on any date is **3.16 MB**.

### `zone_history/` — the exact record, by block of zone index

`zone_history/BBBB.bin.br`, 4096 zones per block, 656 blocks, 37.2 MB, **35 KB median**.
Columns are `idx` (uint32 delta), `day` (uint16), `control_state` (uint8) and the three
counts (int32). Cut by zone rather than by date so a hover fetches one block, not the lot.

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

### Immutability and nightly updates

`dist/` is gitignored and the nightly run uploads it. A bucket has no history, so git bloat
is not a concern.

1. **Shard names are stable, so `Cache-Control` is what decides correctness.**
   `immutable` is a promise that the bytes at a URL will never change, and the browser holds
   it for the full year without asking again — a hard reload does not override it. Marking a
   shard that churns as immutable means a returning reader keeps yesterday's map.

   `upload.py`'s `_cache_control` sets it per object:

   | | Cache-Control | Why |
   |---|---|---|
   | `tiles/`, `terrain/`, `names/`, `zone_ids`, `lookups`, `boundaries*` | immutable, 1 year | positions and labels; rewritten byte-identically every run |
   | `display/YYYY` and `anchor_YYYY` for a **past** year | immutable, 1 year | finished history |
   | `paint/`, `display/<current year>`, `zone_history/`, `series/` | `max-age=300, must-revalidate` | rewritten nightly under the same name |
   | `meta.json` | `max-age=60` | how a client discovers everything else |

   A 304 carries no body, so the cost of revalidating is a header exchange, not a
   re-download.

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

`_previous_index` hands the stable index to DuckDB **through a temporary Parquet file**, not
`con.register`. Passing a polars frame directly goes through Arrow and so needs pyarrow, a
large dependency for one handoff; both sides speak Parquet natively.

Still churning nightly and not yet addressed: `series/country.bin.br` and
`series/region.bin.br` rewrite in full (4.1 MB). Shard them by year when it matters.

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
- **`upload_all` deletes every bucket key the export does not name.** The `raw/` prefix is
  explicitly excluded, and the archive's own sweep is scoped to `raw/` in reverse. Remove
  either fence and one job silently destroys the other's data.
- **`schema.py` is the dtype contract, not documentation.** Two paths write this Parquet and
  DuckDB reads them through one glob; a column differing in width between them makes the
  source unreadable, not merely inconsistent.

## Performance notes

- Query cost is dominated by planning, not transfer. Bigger chunks beat more chunks.
- Filter inside CTEs, not after — the event stream is 9.88M rows.
- `BETWEEN` needs the low bound first or it silently returns nothing.

## Conventions

- Ingest is **idempotent**: the merge is keyed, so re-reading a slot is a no-op. Writes go
  to a `.tmp` then atomically rename, so interruption never leaves a partial file.
- `data/` and `dist/` are gitignored. `dist/` is fully rebuildable; `data/` is not — see
  "The raw layer".
- Conventional commits: `feat:`, `fix:`, `data:`, `docs:`, `refactor:`.
- Testing is deliberately concentrated where failures are invisible, not spread evenly.
  dbt carries 12 data tests and 1 unit test; `pipeline/tests/` covers the ring arithmetic
  and the dtype contract, which decide what gets written before dbt can see it. The viewer
  has none. `dbt source freshness` warns at 2 days stale and errors at 7 — well inside the
  31-day ring, so there is time to act before a gap becomes unrecoverable.
