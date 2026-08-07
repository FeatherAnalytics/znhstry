# Continuity: Zone History viewer

## Goal

A fast, browsable dashboard of QONQR's history, for a dozen to twenty readers a day.

Done looks like:
- All 2.68M zones drawn as individual points, at every zoom.
- Any date in the fourteen-year record reachable without downloading the event stream.
- One row of views: Current, or a window from Day to All time.
- A real basemap underneath, so a reader can tell where they are looking.
- Country/region/near-me filters driving the panel and the chart.
- Factions keep their colours: Faceless purple, Legion red, Swarm green.

## Constraints

- **No zoom-based LOD.** Every zone, at every zoom. Spatial *sharding* is the mechanism.
- **The SQL mirror is the source of truth**, weird geography included. No hand-cleaning.
  `CountryId` wins over `RegionId`; the region label is suppressed, never reassigned.
- `idx` is a permanent handle. New zones append; nothing renumbers.
- Requests, not bytes, are the binding constraint while the data is on an `r2.dev` URL.
- Tests are not the priority. Working UX is.

## Key decisions

- **The client holds no per-zone bot counts.** `display/` carries one byte per zone-day for
  what the map draws; precomputed series answer aggregate questions; `zone_history/` answers
  exact ones for a single zone on hover. Landing on any date costs ≤ 3.16 MB.
- **One byte, `pk`, everywhere.** Faction in the top two bits, log-magnitude in the low six.
  `paint/` and `display/` speak it, so nothing converts between representations.
- **A row per zone-day with any event**, not only where `pk` changed. ~2 MB more across the
  record, and it is what makes "did this zone move" exact rather than a bucket comparison.
- **Colour is the faction with the most bots**, ties broken by the holder when the holder is
  one of them.
- **Current and the windows are peers**, not a mode toggle crossed with a duration.
- **Windows open on the last complete day; Current opens on the newest date.** A level is
  correct at any moment; a window ending mid-day is not.
- **Clicking a zone changes only the panel and chart**, never the map.
- **Empty zones are off by default.**
- **Every date is a full rebuild in a worker.** Backwards costs what forwards costs.
- **16-degree tiles and idx-blocked names**, both to cut requests: a cold load is 422 and
  11.6 MB.
- **Data in R2, site on GitHub Pages.** R2 because `Content-Encoding: br` and
  `Cache-Control: immutable` are impossible on Pages.
- **CARTO `dark_all` basemap** under the dots, with attribution. Our own boundary rings fade
  out above zoom 5 where their 1.1 km simplification starts to show.

## State

- Done:
  - [x] Export: `display/`, `zone_history/`, `names/`, `series/{country,region,cells}`,
        16-degree geometry tiles, packed `pk`
  - [x] Client: worker-driven display replay, series-backed panel and chart, lazy names and
        per-zone history, basemap, one-row view picker
  - [x] `upload.py` wired to the CLI as `znhstry upload`, skipping objects by ETag
  - [x] Data current through 2026-08-06; marts rebuilt; export regenerated
  - [x] `tsc --noEmit` clean, 9 dbt tests passing
  - [x] Verified in the browser against the real 2.68M export (see below)
  - [x] CLAUDE.md rewritten to current state
- Now: [→] Nothing in flight.
- Remaining:
  - [ ] **The R2 bucket is empty.** `.env` points `NEXT_PUBLIC_DATA_ORIGIN` at
        `pub-110a5c98bf1e495fa02397b90fd12708.r2.dev` and `/global/meta.json` returns 404.
        `znhstry upload` has never been run. This is the only thing between the current
        state and a working public site.
  - [ ] Watch whether `r2.dev` throttles 422 requests per cold load at this readership. If
        it does, the fix is a Cloudflare custom domain — free, keeps your registrar, just
        move the nameservers — which puts a CDN in front.
  - [ ] Re-run the determinism check against the current trees.
  - [ ] `series/country.bin.br` and `series/region.bin.br` rewrite in full nightly (4.1 MB).
        Shard by year if it matters.

## Open questions

- UNCONFIRMED: the nightly workflow has never run end to end. It now calls
  `znhstry upload`; `upload.py` itself has never run against a real bucket.
- UNCONFIRMED: all timings are local, on a dev build, throttled to Fast 4G.

## Verified in the browser

Against the real global export, all 2,682,442 zones:

| | |
|---|---|
| cold load | 422 requests, 11.6 MB |
| played world complete / every zone (Fast 4G) | 3.3 s / 8.4 s |
| scrub across eleven years, nothing cached | 526 ms |
| panel faction totals vs `meta.current` | exact match |
| Day / Week / Year zones moved | 3K / 12K / 250K |
| zone 1529645 exact counts vs DuckDB | exact match |
| United States country series vs DuckDB | exact match, all three factions |
| Tokyo-to region series vs DuckDB | 5,354 / 795,692 / 12,449, 41 zones — exact |
| hover readout vs DuckDB | Kulakovo, Belarus, Legion, 370 bots — exact |
| hover over a hidden zone | reports nothing, 8 of 8 probes |
| click a zone | panel and chart switch, map untouched |

Kulakovo's last event was 2020-08-20 and it reads correctly on 2026-08-07, which is the
carry-forward case a naive "replay recent events" design gets wrong for the 504,410 zones
that last changed in 2019 or earlier.

## Working set

- Branch: `restore/untiled-viewer`
- Two servers in dev: `cd web && npm run data` (:3002) **and** `npm run dev` (:3000). The
  map is empty without the first.
- Refresh chain: `znhstry update` -> `dbt build` -> `znhstry export` -> `znhstry upload`
- `web/lib/`: `format`, `displayWorker`, `displayProtocol`, `series`, `zoneHistory`, `names`,
  `filters`, `geometry`, `data`, `useZoneData`, `windows`, `boundaries`

**This repo's own notes are not evidence.** Both the upstream repo and the live API are one
command away; check them before believing a claim about the data.
