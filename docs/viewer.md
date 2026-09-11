# The viewer

**Every zone, at every zoom.** The map draws all **2,682,442** zones as individual points,
including the 1,087,356 that have never held a bot.

## The client never holds the event stream

This is the single most important fact about the viewer. **The browser downloads no
per-zone bot counts at all.** Three questions, three answers, none of which need it:

| Question | Answered by |
|---|---|
| what colour and size is every dot on date D | `display/`, one byte per zone-day |
| how many bots in this country / region / area over time | precomputed daily series |
| exactly how many bots on *this* zone | `zone_history/`, one 35 KB block, on hover |

A cold load is **343 requests and 11.5 MB**, and that is everything needed to draw all
2.68M zones:

| Pass | Gives | Requests | Size |
|---|---|---|---|
| `tiles/` + `paint/` | every zone, positions and colours together, nearest first | 336 | 9.26 MB |
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
| every zone on the map — all 2.68M, correctly coloured | **8.4 s** |
| scrub across eleven years, nothing cached | **526 ms** |

Measured before the tiles and terrain were merged, so the first figure covered the played
world at 3.3 s and everything at 8.4 s. One pass now delivers both at once; re-measure
rather than trusting the old split.

Priority order between passes is load-bearing. `display/` is not touched until the reader
asks for a date `paint/` cannot answer: 3 MB in front of the tiles they are watching
arrive stretched the world from 11 s to 44 s when measured.

## Requests are the binding constraint, not bytes

The data is served from `data.znhstry.com`, a custom domain on the bucket. R2 egress is
free and 94.7 MB of storage is nothing, so **cost is not the issue**. Requests are: every
one is a round trip, and a cold load is 343 of them. That is why the tile grid is 16 degrees
and names are off the load path.

The custom domain removes the rate limit that `r2.dev` carries; it does not remove the
request count. Objects are served `Cache-Control: public, no-cache`, which Cloudflare's
edge does not cache, so every request reaches R2 and the count is what it is. For a few
dozen readers a month that is well inside the free tier and needs no edge cache. Putting
one in front would reopen the fresh-manifest-plus-stale-shard failure that `upload_all`'s
ordering exists to prevent, unless the upload also purged the edge.

## One row of controls

Mutually exclusive choices, not a window plus a mode toggle:

- **Current** — where things stand now. Every zone holding bots, sized by how many, on the
  newest date in the record. No window involved.
- **Day / Week / Month / Quarter / Year / All time** — only the zones that saw activity in
  that span. Everything else is hidden outright, not dimmed.

**Current is the default, and the reason is load time as much as framing.** It is the only
view that needs no display stream at all — `paint/` already answers it — so the map is
complete and correctly coloured after the first tile pass, with nothing else fetched. Every
window is a change window, so choosing one forces an anchor plus a year of `display/`, up
to 3.16 MB, before the map is right. Defaulting to a window puts that in front of every
cold visit.

Current and the windows are peers because they are different questions, not modifiers of
one another. A window paired with a "show everything" mode makes half the combinations
duplicates and implies the window means something it doesn't.

**The playhead skips the day still in progress.** A window ending mid-day undercounts for a
reason that has nothing to do with the game, so every window opens on the newest *finished*
day. `Current` goes to the newest date instead, because a level is correct at any moment
and only a window is sensitive to a partial day. `lastCompleteDay()` treats only the
current UTC date as unfinished, so a stale export whose newest day is a week old is left
alone.

**The opening date is the newest one, and that is a load-time invariant, not a preference.**
`paint/` answers exactly one date — the newest in the export — so opening a single day
earlier means the first frame cannot be painted from the tiles and the worker fetches an
anchor plus a year of `display/`, up to 3.16 MB, in front of the tiles the reader is
watching arrive. A nightly export's newest day *is* today, so this fires on every cold load
in production and on none locally against a stale `dist/`. `useZoneData` opens on the series'
last day and `changeView` clamps to `lastComplete` when a window is chosen.

**"Moved" means the zone had an event in the window**, not that it crossed a size bucket.
No second state is built to answer it — it is a question about whether rows exist, and
`display/` carries a row for every zone-day with an event precisely so the answer is exact.
That costs ~2 MB across the record against emitting only rows where the packed byte
changed, and it is worth it: at eight buckets per decade a bucket spans a 33% change in bot
count, so a bucket comparison would hide every skirmish smaller than a third of a garrison.

A window's first frame paints everything from `paint/` and applies the filter when the
display data lands. `ZoneDisplay.visible` starts all-ones, so the map is never blank
waiting on 3.6 MB.

## Colour

**A dot's colour is the faction with the most bots standing in that zone on the snapshot
date.** The view only ever decides which dots are drawn.

Not `control_state`, which names whoever captured the zone last and keeps naming them long
after their last bot is gone. The two agree almost perfectly — across all 9.88M events they
differ for 705 events, because in QONQR control follows the garrison — but
the rule is written the honest way so it stays right if that changes. On a tie the holder
breaks it, and only when the holder is one of the tied factions; otherwise a fixed order
does.

Never colour by *which faction gained most* over a window. That is a delta, it makes the
colour mean two different things depending on the view, and one meaning is all a map whose
entire vocabulary is three faction colours can carry.

## Empty zones are always drawn, and the toggle asks for only them

A zone holding no bots is on the map at all times. "Only empty" hides everything that *is*
held, leaving the unclaimed world by itself.

There is no "hide them" state. Hiding the 1.09M never played plus everything fought down to
nothing removes most of the map to answer a question nobody has; the question worth a
control is the opposite one — where is there nothing — and that is what "Only empty" shows.

**Empty zones answer to the toggle alone, never to the window.** "This zone holds
nothing" is a fact about now, not about the span, so hiding an empty zone because it did
not happen to move this week answers a question nobody asked. Zones that *do* hold
something answer to the window. So a Day window is the day's fighting in colour over the
whole world in grey, which is what makes it readable.

It is a render-time test in `ZoneMap`, not a data one; nothing refetches.

**Hidden zones stay in the buffers at radius zero.** Every zone is always present in the draw list; hiding means setting its radius to 0 so the GPU discards the point rather than omitting it from the buffer entirely. A deck.gl pick index is therefore a stable slot, and `ZoneMap`'s `picked()` maps it back through `drawnToSlot` / `terrainToSlot`.

**Terrain is its own layer, drawn underneath.** The 1,087,356 zones never played are empty
in every frame of every year, so their colour and radius cannot change with the date; they
are built when tiles land or the focus mask moves, and never per date. Order is explicit and
must stay that way — terrain over the played world buries it. This is a render-time draw
list and has nothing to do with the geometry export, which keeps every zone in one tile file
(see "Geometry is tiled").

## Focus: an area, a location, or one zone

Two masks, and they are deliberately different:

- **`mapFilter`** — a picked area, near-me, or the circle of a flashpoint. What the map dims
  by. Zones outside it stay on the map at alpha 26; a quarter opacity was not enough,
  because two million faint dots still read as a wash of colour.
- **`filter`** — the selection plus the clicked zone. What the readouts count. A flashpoint
  is deliberately *not* in it: the coarsest series available for a circle is a one-degree
  cell, 111 km against a 48 km ring, so scoping the panel to it would put an approximation
  beside the exact figures the impact readout takes from the flashpoint's own payload.

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

**Every figure in the panel is exact, and the five zone categories are why.** Three faction
counts plus Empty plus Never played sum to the total — 2,682,442 for the whole scope — and
"422K + 625K + 514K + 34K + 1.1M" against "2.7M" is a sum nobody can check. Each row stacks
its label, its bots and its zones rather than sharing a line, because fourteen digits will
not sit beside a zone count and a growth delta in 268 px. The mobile sheet's peek line
carries one exact figure for the same reason: two of them truncate mid-number, and half a
count is worse than a rounded one.

**Clicking a row isolates that category on the map**, as `EMPHASIS` bits in `lib/emphasis.ts`
— one integer, so it can key `ZoneMap`'s incremental repaint, and the faction bits are
`1 << faction`, the arithmetic the fill loop already does on `pk`. It dims rather than hides,
like a picked area, but much harder: the categories are wildly unequal, 33,861 empty zones
against 1.6M held ones, so a dimmed majority at alpha 26 still sums to more colour than the
isolated minority. Off goes to 4, the chosen category to 255, and grey grows as well, having
the least headroom of anything on a dark basemap. Rows stack, and clicking the last one back
off returns to everything rather than to nothing.

It is a highlight and never a selection: it does not reach `filter`, so every count keeps
describing the same zones while the map answers "where are these".

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

## There is a real basemap under the dots

CARTO's `dark_all` raster tiles, via a deck.gl `TileLayer`. An optional API key (`NEXT_PUBLIC_CARTO_API_KEY` in `.env`/`.env.example`, passed by `deploy.yml` from the `CARTO_API_KEY` repository variable) removes the watermark CARTO stamps on unauthenticated tiles. It is drawn
dark precisely so data sits on top rather than fighting it.

Admin borders are not orientation. With the basemap you get coastlines, water, roads and
place names at every zoom: at zoom 10 over Rhode Island you can read Providence, Pawtucket,
Cranston and Narragansett Bay.

- **Attribution is a licence condition, not decoration.** `© OpenStreetMap · CARTO` renders
  bottom-left inside the deck container, above the bottom sheet. Do not remove it.
- **Our own boundary rings fade out above zoom 5 and are gone by 7.** They are simplified
  to 0.01 degrees (~1.1 km), which is invisible at world zoom and plainly wrong at city
  zoom, where a coastline becomes straight lines cutting across a bay. The basemap's own
  borders are more accurate and sufficient by then. The graticule is dimmed for the same
  reason: two grids fight each other.

Tiles are third-party requests, roughly a dozen per view, cached by the browser normally.

## No zoom-based LOD

The map never aggregates zones into cells at low zoom, and the reason is not performance —
**the point of this map is the millions of dots tracing the world**. A 16x16 grid of
coloured blocks is cheaper and says less.

Spatial **sharding** is a different thing and is what the viewer does: every zone is in
exactly one tile, every tile is eventually fetched, nothing is ever aggregated. The grid
only buys an order.

## Two index spaces, and the bug waiting in them

- `idx` — the export's permanent handle. `display/`, `zone_history/`, `names/` and every
  anchor are keyed by it. Stable across nightly runs.
- `slot` — a zone's position in the render buffer, assigned in tile *arrival* order.
  Meaningless outside a session. deck.gl picks return it.

`slotToIdx` / `idxToSlot` in `lib/geometry.ts` convert. Anything touching game state wants
idx; anything touching a GPU buffer wants slot.

## Rebuild for a jump, carry forward for a run — in a worker

`lib/displayWorker.ts` owns the display state and keeps its own copy of it, `state`, along
with the day and year that copy stands at. Two paths reach a requested date:

- **Rebuild.** Zero the buffer, apply the anchor for the target year, then apply that year's
  rows up to the target day — about 1.6M scattered writes plus a 1.4M-row scan.
- **Carry forward.** Any move *forward inside the year the state already sits in*: scan the
  year once and apply only the rows falling in `(held, target]`.

Because the shard is ordered `(idx, day)` for compression, a day's rows are scattered
through it and the scan reads the year either way — so **advancing ten days costs the same
as advancing one**. That is what makes it usable during playback, where the map trails the
playhead and the days it is asked for arrive in jumps. Going backwards, or crossing a year
boundary, rebuilds: backwards has nothing to carry forward, and a new year needs its anchor.

The worker holds `state` itself rather than trusting whichever buffer came back, because a
superseded request has its buffers returned unused and a carry-forward has to build on the
last day *processed*, not the last day drawn.

There is deliberately no by-day index. It would turn a carry-forward into ~3,000 reads
instead of 1.4M, but costs 5.6 MB per year and a counting sort, for a pass that is no longer
on the critical path. Measure before adding one.

`VERIFY_EVERY` in that file rebuilds into a scratch buffer every Nth carry-forward and
compares. It ships at 0. Turn it on and watch it cross a year boundary before believing any
change to `step` or `replay`.

Buffers are lent to the worker and returned rather than reallocated: each `pk`/`visible`
pair is 5.4 MB.

The worker also reports, on request, which zones changed **faction** on the target date —
`flips`, a short list of `idx` with `from`/`to`, derived in the same pass that colours the
map so a mark can never appear on a dot that did not change colour. A busy day is about a
thousand zones and the worst in the record is 10,449, which is why it is a list rather than
a 2.68M-wide mask. Off unless asked for.

Playback is paced by the clock, not by ticks, and the playhead does not wait for the map.
Holding the two in lockstep so the worker only ever saw consecutive days serialises three
React renders per day and is much slower than letting the playhead lead; carrying forward
across a gap is free, so there is nothing to gain by waiting.

## Serve it with `Content-Encoding: br`

Every payload is stored brotli-compressed and served with `Content-Encoding: br`, so the
browser decompresses it and **the client carries no decoding code at all** — a plain
`fetch(...).arrayBuffer()`. `DecompressionStream` has no brotli, so this only works because
the *host* sets the header. A static site host cannot, which is why `dist/data` goes to R2
while the site is deployed separately.

Measured against gzip -6: geometry 10.44 MB -> 8.53 (18%), names 11.81 -> 10.10 (15%),
boundaries 2.80 -> 1.83 (35%).

Two brotli qualities, because the curve has a knee. On a 26.9 MB payload: q9 3.93 MB in
4.5 s, **q10 3.60 MB in 46 s**, **q11 3.43 MB in 130 s**. q11 for anything on the critical
path, q10 for the bulk trees — 4% of the ratio for most of the export's running time.

## Timelapse is a mode, not another window

`Timelapse` sits after a divider in the view row and swaps the bottom bar for its own
controls. It runs on a **date range**, which the windows have no concept of; keeping the two
time models apart is deliberate, because reconciling them would mean rebuilding `StatsPanel`
and the chart around ranges.

**One day per frame, never more.** The other playback loop covers the record in a fixed
twenty seconds and skips whatever it must; this one shows every day and slows down instead,
so a run is as long as its period. The playhead does not wait for the map — the worker
carries state forward across a gap for the cost of one day, so letting it lead is free.
Holding the two in lockstep was tried and is three times slower: it serialises three React
renders per day.

Three backdrops, and they answer different questions:

| | |
|---|---|
| **Daily** | zones with an event that day |
| **All zones** | the standings on that date |
| **Cumulative** | starts unclaimed and fills in — a zone appears the day it changes hands and stays, in whatever color it currently holds |

Two overlays draw on top, through `ZoneMap`'s `overlays` prop:

- **MAZ**, an amber ring per zone, brightness and size both from appearances in a trailing
  30-day window. Amber specifically because it is none of the three faction colors: a MAZ is
  not a faction fact. Flash, decay and streak encodings were built and compared on a real
  map and lost — a one-day flash is ten dots on a world map and reads as nothing.
- **Changes of hands**, a small mark in the new holder's color with a dark disc under it,
  trailing five days and fading. A stroke instead of the disc is most of the mark at that
  size and the color never shows.

**"Changed hands" includes a zone going from empty to held**, and that is not a detail.
Before 2018 the record holds *zero* faction-to-faction changes, so excluding arrivals leaves
the entire early timelapse with nothing to draw. See the data facts above.

`lib/timelapse.ts` is split into two hooks for an ordering reason rather than taste:
`useFlipStream` must hand `absorb` to `useZoneData` before that hook runs, while
`useMazOverlays` needs the geometry and display state it returns.

**The bar counts the day's changes of hands and nothing else.** A count of MAZ rings was
there and said nothing: a ring is an appearance in a trailing 30-day window, so the number
rises and falls with the window sliding rather than with anything happening that day.

**A run's change window is its own range, never a span from the picker.** "Net change over
all time" is a fact about the record; what the reader is watching is a period they chose, so
`useZoneData` takes the range's first day and the panel names it — plus a small line carrying
net bots across the run so far, which is the one number a run is about and which the two
level-reading backdrops would otherwise leave off the screen entirely.

## Flashpoints

A named day, framed and dimmed. Picking one sets the range, the playhead, the camera, the
tile focus and the pace together, and clears the area and near-me selections — a flashpoint
is a third kind of focus, and two at once means neither.

- **It opens on the All zones backdrop.** Daily draws only the zones with an event on the
  date, and on the first frame of a 28-day baseline that is usually none of the few hundred
  inside the circle, so the reader arrives at an empty rectangle.
- **The board days play at a third of a day per second**, against 2.5 for the rest of the run
  and 30 for a record-crossing playback. Those days are the reason the run exists; at the
  surrounding pace they take the same half-second as any other day.
- **The playhead turns amber and says so on those days.** Amber because being the flashpoint's
  day is not a faction fact — the same rule the MAZ rings follow.
- **Leaving the timelapse drops the flashpoint.** It owns a range, a camera and a mask that
  the windows have no way to express; left set behind a window it keeps the map framed on one
  neighborhood and the panel reading a viewport aggregate under a heading that says Global.
- **The impact readout names its spans and its units in words.** Three signed numbers under
  "before", "during" and "after" is a table only its author can read. Figures are exact and a
  one-day total prints no daily rate, being its own. On a narrow screen it renders inside the
  bottom sheet, where the chart it stands in for also lives; in the page's own flow it would
  be laid out under a sheet that is fixed over the map, and the two collide.

**Neither the trail nor the cumulative mask is React state updated from an effect.** Both
live in refs, are filled from the worker's answer handler, and publish with one version bump.
An effect that sets state on every answer makes React count a nested passive update on every
frame, and after fifty without a quiet commit between them it logs "Maximum update depth
exceeded". For the same reason `useZoneData` delays its `scrubbing` flag by 200 ms and
exposes a `pending` ref for pacing: a date answered in tens of milliseconds must not touch
React state at all.

**The MAZ payload carries no key it does not need, and nothing it can get elsewhere.**

| | Columns | Size |
|---|---|---|
| `maz.bin.br` | `idx` (uint32), `day` (uint16 delta) | 268 KB -> **63 KB** |
| `maz_stats.bin.br` | `report` (uint32), `players` (uint16), `launches`, `legion_launches`, `swarm_launches`, `faceless_launches`, `bots_launched`, `bots_killed`, `bots_lost` (int32) | 1.55 MB -> 624 KB |

**`report` is the one column here that is a reference rather than a measurement.** It is
QONQR's own battle report number, and it exists so a row can point at the page it came
from — `portal.qonqr.com/Home/BattleStatistics/<report>`. Nothing else in the payload can
be turned into that link. Not delta-encoded: reports are numbered in the order QONQR wrote
them while these rows are ordered `(day, idx)`, so the sequence climbs across days and
scrambles within one.

**The three faction launch columns do not always sum to `launches`, and the exception is
dated.** 861 reports fall short, all between 2019-07-01 and 2019-09-11, report numbers
55800–57858, with the total higher on every one. The faction *player* columns fail on
exactly the same rows, which is what shows it to be the whole per-faction block arriving
partial rather than anything about launches — outside that window both splits are exact on
all 60,496 reports. It is not a top-N player cap (the largest faction-player sum is 939,
and 5,537 reports with over 50 players outside the window reconcile), not a zeroed faction,
and not the big collection days. Only the date predicts it, and geography does not: every
country with 10+ reports in the window is 72–97% short, and Atlantis — which has no
geography at all — sits at 83.1%, on the window's average. Forty of the seventy-two days
are 100% short. Anything computing faction share drops that window or states it.
`stg_battlestats` carries the full working, and
`tests/test_export_maz.py` asserts the *containment* rather than the count.

45,685 reports over 11,723 zones, sorted `(day, idx)` because every read is a contiguous
range of days. That ordering is why `idx` is not delta-encoded: it restarts on every day
boundary, and `_pack` only accepts ascending runs for an unsigned column.

**`maz_stats` is row-aligned and has no key columns at all** - row *i* describes row *i* of
`maz.bin.br*, and `idx` joins on to the geometry, names and history the viewer already
holds. Both queries share a `group by` and `order by`; change one and you must change both.
Coordinates and names are deliberately absent: `tiles/` and `names/` already hold them at
the same `idx`, and a second copy is a second chance to disagree.

The map fetches only `maz.bin.br`, and only on entering the mode. Nothing on screen depends
on a launch count - a ring's brightness and size are both appearances in a window - so the
stats exist to be collected automatically rather than to be drawn. A per-*player* breakdown
is a separate job: the report pages carry a packed string of roughly 924,728 player rows
that ingest does not unpack. See `thoughts/future-features.md`.

**Each player row on the report page carries the player's faction as the `<tr>` CSS class** (`Swarm`, `Legion`, `Faceless`) and two badge spans: `<span class="atlantis-gold">` for TournamentMillionKills and `<span class="gold-star">` for WeeklyMillionKills. `parse_report` extracts these into per-player rows written to `data/raw/battlestats/players/year=YYYY/rows.parquet`, keyed on `(BattleReportNumber, Rank, PlayerName)`. The packed `players` string is unchanged. `stg_atlantis_battle_players` reads from the per-player table where available and falls back to the packed string for older reports; faction and badges are null on the fallback path until the backfill repopulates them.

**The backfill (`znhstry backfill`) re-fetches historical report pages for per-player rows.** Paced at `BACKFILL_INTERVAL` (10 s) to stay polite, newest first, with a 5-hour budget per run. Scheduled by `backfill.yml` itself at 02:00, 09:00 and 15:00 UTC (GitHub fires these hours late; that is acceptable here because only resumption matters); each run stops at the earlier of its 5-hour budget and 00:30 UTC so it never holds the concurrency group when the 00:45 nightly fires; the gate runs before the restore so a scheduled run after completion costs one request; the lines can be removed once remaining hits 0 but do not have to be. Pages that fail to parse are recorded in `skipped.txt` with a reason (`unavailable` or `unparsed`) so they are not retried. `backfill_state.json` carries remaining count and is read by the workflow's gate. The `battlestats-players` concurrency group serializes the backfill and the nightly's player writes; `cancel-in-progress` is false so a 5-hour run is not killed by a nightly firing.

## The Atlantis page

`/atlantis` is a client-only route that reads the `atlantis/` export tree — `index.json.br` for the tournament list and all-time standings, one `YYYY-MM.json.br` per month for hourly series. Three tabs: Dashboard, History, All Time. URL state (`t`, `player`, `zone`, `tab`) is bookmarkable via `useSearchParams` under a `<Suspense>` boundary (required for static export).

**The coverage line exists because a partial month must never read as a quiet one.** September 2026's coverage is the last 27 hours of a five-day tournament, and without the line a reader sees placements and a leaderboard and assumes they describe the whole battle. The line names the observation window with times, not just dates.

**The player detail's gains bars cover only the observations we hold**, not the tournament total. A player who launched 2,000 in stacking and 500 in our coverage window shows 500 in the gains bars. The title attribute says so for the same reason the coverage line exists: a partial window must not imply a complete picture.

**Rates are per hour because observations are hourly.** The payload's `launches_gained` is per interval and the early intervals in a collection run are two hours long, so plotting raw values shows a false burst where the observation gap was wider. Dividing by the interval's minutes and showing launches per hour normalizes this. The same computation drives the leaderboard's "Best /hr" and the player detail's top-3 interval labels.

**Zone detail and player detail carry battle report tables.** The hourly source (`stg_atlantis_zones`) names no players, so `fct_atlantis_zone_player_daily` unpacks the per-report player string from `stg_battlestats` for tournament zones. The list is QONQR's daily top 50, not a census, and the header says so. September 2026 has battle reports for days 1-6 while the hourly collector covers days 4-6 only, so days 1-3 are battle-report-only coverage. The stable zone position key (`zone`) is filled by joining `stg_atlantis_zone_months` and is null for months before September 2026; the report's own zone name is always present.

**Placements are computed by the game's rule**, ranking factions by zones held at the last observation, with Prime as the first tiebreaker and total faction bots as the second (see "Atlantis marts" above). The label says "Final" on finished months and "If standings held" while one runs, because standings can change until the end and the label must say so.

**Qredits are labeled "estimated" while a month runs.** The payout mart computes each player's share of their placement's pool, but placement is not settled until the last observation. A running month's qredits use the current standings, so the figure moves until the tournament ends.

**Derived months render a static dashboard from battle report data.** No time-series charts (there are no hourly observations); a zones table ordered by triangle replaces the zone cards; players are grouped by attributed faction with an Unconfirmed group at the end; rows are not clickable (no player or zone detail). "Not yet attributed" appears where the backfill has not reached and all players are Unconfirmed. History and All Time merge derived months with collected ones, labeled "derived" in muted text.

## The SQL console

`/query` runs DuckDB-WASM in the browser over the published marts. The SQL uses plain table names (`select * from fct_country_daily where is_latest`); `lib/duckdbWasm.ts` binds each referenced table on demand from `_meta.json` as a `CREATE VIEW … read_parquet(url)`. `?sql=` is a permalink that loads and runs the query on page open; a "Copy link" button writes it.

**DuckDB-WASM issues a full GET, not range reads, for a bound mart.** A permalink over `fct_zone_events` pulls ~190 MB. Smaller marts are fast — the country daily is ~7 MB. This is a client behavior; every server precondition for ranges is met.
