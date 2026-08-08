# Zone History

A historical map of [QONQR](https://qonqr.com) zone control — where all 2,682,442 zones
stand, what moved over any window, and how fourteen years of territory got that way.

**[www.featheranalytics.dev/znhstry](https://www.featheranalytics.dev/znhstry/)**

Most maps of this data show the present. This one shows the past: scrub to any date, pick a
window, and watch faction control shift across a region.

## Reconstructing a map from a sparse event stream

The source records a row only when a zone changed. That makes "what did the map look like
on this date?" a genuinely hard question.

- **32% of ever-active zones last changed in 2019 or earlier.** Slice history by a recent
  window and you silently drop half a million zones that still hold territory.
- Rebuilding dense daily state the obvious way is 2,682,442 zones × 5,100 days =
  **13.7 billion cells**. Storing one byte per zone-day that actually saw an event makes it
  linear in events instead: 9.88M rows.
- The browser has to do this too, which means it can never hold the event stream.

## What the browser downloads

A cold load is **422 requests and 11.6 MB**, and that draws every zone at the right colour.
A dot's colour and size are a single byte, faction in the top two bits and a log-magnitude
bucket in the low six. History stores that same byte, so nothing converts between two
representations and a scrub across eleven years costs 526 ms.

Per-zone bot counts are never downloaded in bulk. Hovering a dot fetches one 35 KB block.

| Measured on fast 4G, cold cache, dev build | |
|---|---|
| played world complete, 1.6M zones, correctly coloured | 3.3 s |
| every zone including never-played terrain, 2.68M | 8.4 s |
| scrub across eleven years, nothing cached | 526 ms |

## Architecture

```
QONQR's published CSV drop
  -> Parquet (data/raw, year-partitioned)
  -> dbt-duckdb (staging -> marts, tested)
  -> static binary shards
  -> Cloudflare R2 (brotli, per-object cache policy)
  -> Next.js + deck.gl on GitHub Pages
```

| Layer | Tool |
|---|---|
| Ingest | Python 3.13, `httpx`, `polars` |
| Warehouse | DuckDB |
| Transform | dbt-duckdb: staging, marts, data tests, unit tests, exposures, source freshness |
| Export | Python, columnar dumps under brotli |
| Web | Next.js static export, deck.gl, D3 |
| Host | GitHub Pages for the site, Cloudflare R2 for the data |

The data lives apart from the site because it needs two response headers a static host
cannot set. `Content-Encoding: br` lets the browser decompress, so the client ships no
decoding code. A per-object `Cache-Control` marks a shard `immutable` only where that is
true, which matters because shard names are stable and a nightly run rewrites some of them.

## Running it

```bash
cd pipeline
uv sync
uv run python -m znhstry restore   # pull the raw layer from object storage
uv run python -m znhstry ingest    # read the latest day from QONQR's drop

cd ../transform && uv run dbt build     # ~25 s over 9.88M events
cd ../pipeline  && uv run python -m znhstry export
```

Run `restore` first. The daily drop is a 31-slot ring covering the last month, so it cannot
rebuild a record that starts in 2012.

## Data source

QONQR publishes its own zone data to a public Dropbox folder: 31 rotating daily CSVs plus
country and region lookups. That is the only live source this project reads.

Battle reports come from the game's own portal, ten a day, indexed by its Most Active
Zones page. The scraper runs serially with a delay between requests and asks only for
report numbers it does not already have, so an ordinary day costs one index page.

The 61,517 rows of history behind that came from the community scrape at
[neon-ninja/QONQR_zonedata](https://github.com/neon-ninja/QONQR_zonedata), copied once.
Report numbers are sparse across their range, so collecting them directly would have
meant roughly 130,000 requests to a server that did not need them.

## Licence

MIT.
