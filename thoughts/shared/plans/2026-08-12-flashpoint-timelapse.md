# Flashpoints on the map: a framed timelapse with its own impact readout

**What this builds:** a named flashpoint — Marquette 2022-03-27, Adelaide 2024-09-12, Chermignac
2017-05-22 — becomes a single click that frames the map on it, runs the timelapse across the days
around it, marks the zones that were actually on the leaderboard, and charts what happened to the
bots in the surrounding 30 miles against the month before.

**Why it needs building rather than assembling:** everything visual already exists. The timelapse
runs a date range, `ZoneMap` takes an `overlays` list and draws a `RangeRing`, `radiusFilter` dims
outside a circle, and `zoomFor` turns a span into a zoom. What does not exist is the *data*. The
flashpoints were found by querying all 9.9M changelog events, and the client deliberately never
holds that stream — so the impact series has to be precomputed, per flashpoint, in the export.

---

## The shape of it

Five pieces, in dependency order:

1. **`transform/seeds/flashpoints.csv`** — the curated list. Version-controlled, so the export is
   reproducible and adding a flashpoint is a one-line diff.
2. **`transform/models/marts/fct_flashpoint_impact.sql`** — the daily two-group net-bot series for
   each flashpoint's circle, computed in dbt where the full event stream lives and where the tests
   are.
3. **`pipeline/src/znhstry/export.py`** — `_export_flashpoints`, packing the definitions and the
   series into `flashpoints.json.br` and `flashpoints/<id>.bin.br`.
4. **`web/lib/flashpoints.ts`** — loader, framing math, and the overlay layers for the marked zones.
5. **`web/app/page.tsx` + `web/components/TimelapseBar.tsx`** — a flashpoint picker beside the
   period presets, and an impact panel that replaces the chart while a flashpoint is selected.

---

## Phase 1 — the seed

`transform/seeds/flashpoints.csv`, one row per flashpoint:

| Column | Meaning |
|---|---|
| `flashpoint_id` | stable slug, e.g. `marquette-2022-03-27` |
| `label` | what the picker shows: `Marquette, Michigan` |
| `anchor_zone_id` | `ZoneId`, never a name — `Description` is not unique, and 2026-06-13 has two different zones both called Diamond Springs |
| `board_start`, `board_end` | the flashpoint's own days; equal for a single-day event |
| `run_start`, `run_end` | what playback covers, normally the board window plus 28 either side |
| `radius_km` | defaults to 48.28032, carried explicitly so a wide campaign can ask for more |
| `blurb` | one sentence, shown under the picker |

**The board window and the playback window are separate columns, and conflating them breaks the
long flashpoints.** Adelaide's campaign runs 2024-08-20 to 10-17, and 70 distinct zones appear on
the leaderboard across it — most of the circle's active zones. Define `on_the_board` over that whole
span and the "neighbors" group becomes the quiet remainder, so the split stops contrasting the fight
with its surroundings and starts contrasting activity with inactivity. Adelaide's board window is
its three tightest days, 09-12 to 09-14, while playback still covers the whole campaign.

For a single-day flashpoint the two windows collapse to the obvious thing: board is the day, run is
the day plus 28 either side.

**The anchor is a zone, not a coordinate.** Coordinates would be a second copy of something
`tiles/` already holds, and a second chance to disagree — the same reason the MAZ payload carries
no coordinates. The export resolves the anchor through `dim_zone`.

Seven rows to start, and they are already measured:

| `flashpoint_id` | Label | Window | Why |
|---|---|---|---|
| `chermignac-2017-05-22` | Chermignac, France | 2017-05-22 | The record's largest battle: 201 players, 17,885 launches |
| `breda-2017-05-15` | Breda, Netherlands | 2017-05-15 | 153 players, 11,649 launches |
| `williamsport-2015-01-16` | Williamsport, Pennsylvania | 2015-01-16 | 132 players, 9,821 launches |
| `south-whittier-2017-05-22` | South Whittier, California | 2017-05-22 | 149 players, on the same day as Chermignac |
| `dartford-2019-07-16` | Dartford, Kent | 2019-07-14 → 07-16 | The tightest region-day in the record, 10.9 km across |
| `canterbury-2019-06-11` | Canterbury, Kent | 2019-06-07 → 06-11 | The only six-zone region-day, reached down the Thames estuary |
| `marquette-2022-03-27` | Marquette, Michigan | 2022-03-27 | 25.8 km across, and the clearest impact signal we have |
| `adelaide-2024-09-12` | Adelaide Hills, South Australia | 2024-08-20 → 2024-10-17 | A four-month campaign; the three tightest days are its middle |
| `hebron-2023-12-22` | Hebron, Texas | 2023-12-22 | Hebron's only three-neighbor day |
| `dallas-2024-03-25` | Dallas, Texas | 2024-03-25 | The sixth largest report ever, with no territorial consequence |

## Phase 2 — the impact mart

`fct_flashpoint_impact` is one row per `(flashpoint_id, activity_date, on_the_board)`, carrying the
day's net change and the running level for that group.

Grain and membership:

- **A zone belongs to a flashpoint's circle** when it is within `radius_km` of the anchor by
  haversine. The bbox prefilter must be padded — `_BBOX_MARGIN = 1.05` exists in `export.py` for
  exactly this, because 111.32 km per degree is a mid-latitude average and an unpadded box is
  narrower than its own radius.
- **`on_the_board` is true** when the zone appeared in MAZ inside the *board* window, not when it has
  ever appeared and not across the whole playback range. The question the chart answers is what the
  reported fight did to everything around it.
- **`net_delta` sums the step at each event day**, never a per-calendar-day difference. The
  changelog is sparse by design: 504,410 zones last changed in 2019 or earlier, so treating an
  absent day as a zero discards a third of the map. The step is `total - lag(total)` over
  `(zone_id order by observed_at)`, and the lag runs over the zone's whole history rather than the
  window, so the first day inside the window is measured against the last time that zone actually
  moved.
- **Resolve the circle before the window function, not after.** `lag` partitioned by zone over
  `fct_zone_events` is a sort of all 9.9M rows; the same window over the few hundred zones inside a
  48 km circle is nothing. Build the circle membership CTE first and join to it inside the CTE that
  computes the step — filter inside CTEs, not after, which is the standing rule here for exactly
  this reason.
- **Sort by `observed_at`, never `activity_date`.** 653,123 zone-days carry more than one event, so
  ordering by the date leaves them tied and DuckDB's parallel sort emits them in whatever order it
  finishes in. `(zone_id, observed_at)` is unique across all 9.9M rows.
- **The window is the flashpoint's days plus 28 either side**, so the chart can show the baseline,
  the event and the aftermath without the client asking for a second payload.

**Every flashpoint also carries `zones_moving` per day** — how many distinct zones in the circle had
an event. This is not decoration. It is the column that exposes the pre-2020 gap: for Chermignac,
Breda, Williamsport, South Whittier and both Kent days, the zones that were fighting have **zero
events** across the surrounding 56 days, because the changelog before late 2018 is a thin stream of
first sightings and 2019 is the collection gap. Without that count a flat zero line reads as "the
neighborhood was calm" when it means "we have no rows."

So the mart carries a per-flashpoint `changelog_covered` boolean, true only when the on-the-board
zones have events inside the window. Three tests:

- `assert_flashpoint_anchor_resolves.sql` — every seeded `anchor_zone_id` exists in `dim_zone` and
  has coordinates. A typo would otherwise produce an empty circle and a chart of zeros.
- `assert_flashpoint_groups_partition_the_circle.sql` — the two groups sum to the circle's zone
  count, with no zone in both.
- `assert_flashpoint_coverage_is_flagged.sql` — no flashpoint is marked covered while its
  on-the-board zones have no events in the window.

## Phase 3 — the export

`_export_flashpoints(con, out)` in `export.py`, called from `export_all` **before** `meta.json` is
written, since the manifest carries the definitions it returns.

**`export_all` must write this itself.** The upload sweeps every bucket key the data directory does
not contain, so anything only a separate command writes is deleted from R2 on the next nightly — and
the viewer swallows the missing file, so the panel would just stop appearing. This is the same trap
`export_all` already avoids by writing the boundary payloads inline.

**One file for every flashpoint's series, and the definitions inside `meta.json`.**

| | Contents | Size |
|---|---|---|
| `meta.json`'s `flashpoints` entry | the definitions, anchor lat/lon, resolved board-zone `idx` per flashpoint, `changelog_covered`, day bounds, and the row range each one owns in the shard | ~4 KB of a file already at 124 KB |
| `flashpoints.bin.br` | `flashpoint` (uint8), `day` (uint16), `on_the_board` (uint8), `net_delta` (int32), `zones_moving` (uint16), sorted `(flashpoint, on_the_board, day)` | ~10 KB for ten |

A file per flashpoint would be ten objects and ten possible requests to carry ten kilobytes, and
requests are the binding constraint on an `r2.dev` URL with no CDN — that is why the tile grid is 16
degrees and why names are off the load path. One shard is one request, fetched when the picker opens,
and it is small enough that fetching every flashpoint's series to show one is not worth avoiding.

Folding the definitions into `meta.json` removes a second file and a second request. The manifest is
plain JSON rather than a compressed payload, so this is ~4 KB on 124 KB — 3% of a file every cold
load already pays for, against a request that would only ever be made after one.

There is consequently **no `flashpoints/` tree**, so `_clear_shards` needs nothing: a single shard is
overwritten in place every run and cannot strand orphans.

`_pack` bounds-checks every integer column, and `net_delta` is the one to watch: Marquette's
on-the-board group loses 27,813,744 bots in a day, which fits int32 with room, but a
`sum(net_delta)` over a wide campaign is the kind of value that grows into a field width. It is
signed, so the guard is on both ends.

`net_delta` is stored as the per-day step rather than the running level, for the reason the other
series already do: a delta is a small number that compresses and a running total is a nine-digit one
that does not. The client prefix-sums per group.

`meta.json` gains a `flashpoints` entry naming the manifest, the shard path, and the column spec.

## Phase 4 — the client

`web/lib/flashpoints.ts`:

```ts
export interface Flashpoint {
  id: string;
  label: string;
  blurb: string;
  anchor: { lat: number; lon: number };
  /** The flashpoint's own days: what `on_the_board` is measured over. */
  boardStart: number;
  boardEnd: number;
  /** What playback covers, normally the board window plus 28 either side. */
  runStart: number;
  runEnd: number;
  radiusKm: number;
  /** Zones on the leaderboard inside the board window, by export idx. */
  boardIdx: Uint32Array;
  /** False before 2020: the changelog has no rows to answer with. */
  changelogCovered: boolean;
}
```

**Framing.** The ring is the statistic and the viewport is the context, and they are deliberately
different radii:

```ts
/** The circle the impact series describes: 30 miles, NEIGHBORHOOD_KM. */
const RING_KM = 48.28032;
/** What the viewport shows around it, so the ring sits inside with room. */
const FRAME_KM = 80.4672; // 50 miles
```

Framing reuses the near-me path exactly — `spanLat = (FRAME_KM / 111.32) * 2`, longitude divided by
`cos(latitude)`, then `zoomFor`. At Marquette that lands near zoom 7.2 on a 1280×720 viewport, which
is worth knowing for a second reason: **our own boundary rings are gone by zoom 7**, so orientation
at a flashpoint comes entirely from the CARTO basemap's coastlines, roads and place names. That is
the intended behaviour — the rings are simplified to 0.01 degrees and are plainly wrong at city
zoom — but it means the flashpoint view has no admin outlines and should not be given any.

Selecting a flashpoint sets six things at once:

1. `setRangeStart` / `setRangeEnd` to `runStart` / `runEnd`, so playback opens on the baseline and
   carries through the aftermath.
2. `data.setDay` to `runStart`.
3. `setViewState` to the framing above.
4. `data.setFocus(lat, lon)` so the tile queue comes to the flashpoint first and whatever has not
   arrived yet arrives nearest-first around it.
5. The focus mask to `radiusFilter(geometry, lat, lon, RING_KM)`, which dims everything outside at
   alpha 26. **No `ZoneMap` change is needed for this** — the patch key already tracks the focus
   mask by reference identity, so handing over a different mask of the same length repaints
   correctly. That is the bug that erased the first area's dimming when a second was picked, and it
   is already fixed.

   **`radiusFilter` should get a latitude band before the haversine.** It runs a great-circle
   distance for all 2,682,442 zones, and a 48 km circle rejects essentially all of them — one
   subtraction and a comparison per zone in front of the trig turns a click's mask from 2.68M
   haversines into a few thousand. A degree of latitude is never shorter than 110.57 km, so a band
   of `radiusKm / 110.574` cannot exclude a zone the haversine would have kept. Near-me at 1,609 km
   gets the same win, which is the existing path this borrows.
6. `setArea(null)` and `setHome(null)`, because a flashpoint is a third kind of focus and two of
   them at once means neither.

**Marking the zones that were on the board.** A second `ScatterplotLayer` in the `overlays` list,
after the existing MAZ rings so it draws on top:

- Stroked, not filled, at `RING_KM`-independent pixel radius — `flipRadius`'s shape is the right
  model, since a fixed mark that reads at world zoom vanishes inside the dot it annotates by zoom 8.
- Near-white, reusing `MAZ_FRESH` (`255, 246, 224`). **Not a faction color.** Being on the
  leaderboard is not a faction fact, which is why the existing MAZ ring is amber and why this one
  must not borrow red, green or purple either.
- Two rings rather than one thicker one, so a marked zone reads as marked even where several overlap
  — Marquette's five zones sit inside 25.8 km and at zoom 7 they are not far apart.
- Labelled with a `TextLayer` above zoom 8 only. Five names at zoom 7 collide; the same five at
  zoom 9 do not. Names come from `names/`, which the hover path already fetches by index block.

The existing `ring` prop draws the 30-mile circle. It takes a single `RangeRing`, which is exactly
what a flashpoint needs, so nothing there changes either.

## Phase 5 — the impact panel

While a flashpoint is selected the chart area shows its impact instead of the scope series. Two
lines from one payload — on-the-board and neighbors — plus three numbers under them:

```
Marquette, Michigan · 2022-03-27
                        net −28d      the day      net +28d
on the board (5)         −1,093,771  −27,813,744   −4,721,259
neighbors (86)           −6,269,248   −5,815,281   −6,666,315
```

**Report per-day rates beside the totals**, because a one-day window against a 28-day baseline is
not a fair comparison raw. Marquette's on-the-board group loses 712 times its baseline daily rate
and the neighbors lose 26 times theirs; those two multiples are the finding, and the raw totals
alone bury it.

**When `changelogCovered` is false the panel shows a caveat instead of a chart.** The wording
matters — it is missing data, not a quiet neighborhood:

> The changelog has no events for these zones in this window. The battle reports say the fight
> happened; the event stream has no rows for it. Anything drawn here would be an artifact of
> collection, not history.

`TimelapseBar` already carries a `caveat` on its period presets and renders it, so this reuses the
mechanism rather than inventing a second one.

**Zone counts come from the map's own mask, never from the payload.** The panel keeps three counts
apart for a reason — zones in the circle, zones holding bots, and zones the view is drawing — and
mixing them is how it starts lying.

---

## What this does not do

- **No new time model.** A flashpoint sets the timelapse's existing range; it does not introduce a
  third notion of time beside the windows and the range. Reconciling those would mean rebuilding
  `StatsPanel` around ranges.
- **No cluster search in the browser.** The flashpoints are curated because finding them needed the
  whole changelog. `mazClusters.ts` can already cluster a loaded record by distance and that stays
  where it is, on the prototype bench.
- **No aggregation of the dots.** The map never aggregates zones into cells, and a flashpoint view is
  where the individual dots matter most.

## Open questions

- **Is 50 miles the right frame, or should it follow the flashpoint?** Adelaide's campaign spans
  more than 50 miles across, so a fixed frame shows part of it. The seed carries `radius_km`
  already; the frame could be `radius_km * 1.67` instead of a constant. UNCONFIRMED — needs looking
  at on a real map.
- **Playback is too fast for a flashpoint, not too slow.** The timelapse runs at
  `PLAY_DAYS_PER_SECOND = 30`, so Adelaide's 115-day run finishes in under four seconds and
  Marquette's 57-day run in under two. The whole point of a flashpoint is to watch one neighborhood
  for a few days, and at 30 days a second the event is a single frame. Either the rate becomes a
  per-flashpoint column or the mode needs its own slower constant — the existing one is calibrated
  for crossing the whole record, which is a different promise.
- **Does the neighbors line need its own axis?** At Marquette the two groups differ by 5×, at Hebron
  by 1.2×. A shared axis flattens one case and a split axis invites a false comparison.
- **`zone_day` in the hydrate warehouse and the impact mart compute the same thing twice.** The mart
  is authoritative and the hydrate table is for exploring; they should agree, and nothing currently
  checks that they do. A test comparing one flashpoint's circle across both would be cheap and would
  catch a divergence in the day-grain collapse, which is invisible otherwise.
- **The 2019 flashpoints sit inside two known faults at once.** Dartford's baseline reaches back to
  2019-06-18, which is inside both the collection gap and the June-to-September window where
  `bots_killed` matches `bots_lost` on 268 reports. `changelog_covered` being false already
  suppresses the chart, so nothing is drawn wrongly — but if that flag is ever loosened, these are
  the two flashpoints it would mislead on first.

## The ask

Phase 1 is the one worth agreeing before any code, because the seed's columns fix what a flashpoint
*is* — and specifically whether the board window and the playback window are separate. They have to
be: Adelaide is the case that proves it, and a single window there produces a chart whose two groups
no longer mean what the labels say.

Phases 2 through 5 follow mechanically, with one decision still open in each: the playback rate for a
flashpoint, and whether the neighbors line shares an axis.
