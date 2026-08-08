# Zone History

A historical map of [QONQR](https://qonqr.com) zone control — where all 2,682,442 zones
stand, what moved over any window, and how fourteen years of territory got that way.

**[www.featheranalytics.dev/znhstry](https://www.featheranalytics.dev/znhstry/)**

Most maps of this data show the present. This one shows the past: scrub to any date, pick a
window, and watch faction control shift across a region.

## The interesting problem

The source is a sparse event stream — a row exists only when a zone actually changed. That
makes "what did the map look like on this date?" harder than it sounds.

- **32% of ever-active zones last changed in 2019 or earlier.** Slice history by a recent
  window and you silently drop half a million zones that still hold territory.
- Reconstructing dense daily state naively is 2.68M zones × 5,100 days = **13.7 billion
  cells**. Storing one byte per zone-day that actually saw an event makes it linear in
  events instead — 9.88M rows.
- Doing that in a browser means the client can never hold the event stream at all.

## What the browser actually downloads

A cold load is **422 requests and 11.6 MB**, and that draws every zone, correctly coloured.
The trick is that a dot's colour and size are one byte — faction in the top two bits, a
log-magnitude bucket in the low six — and that same byte is what the history stores. So
nothing converts between two representations, and scrubbing across eleven years costs
526 ms.

Per-zone bot counts are never downloaded in bulk. Hovering a dot fetches one 35 KB block.

| Measured on fast 4G, cold cache, dev build | |
|---|---|
| played world complete — 1.6M zones, correctly coloured | 3.3 s |
| every zone including never-played terrain — 2.68M | 8.4 s |
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
| Transform | dbt-duckdb — staging, marts, data tests, unit tests, exposures, source freshness |
| Export | Python, columnar dumps under brotli |
| Web | Next.js static export, deck.gl, D3 |
| Host | GitHub Pages (site) + Cloudflare R2 (data) |

Two deployments, because the payloads need response headers a static host cannot set:
`Content-Encoding: br`, so the browser decompresses and the client carries no decoding code
at all, and a per-object `Cache-Control` that is only `immutable` where that is actually
true.

## Running it

```bash
cd pipeline
uv sync
uv run python -m znhstry restore   # pull the raw layer from object storage
uv run python -m znhstry ingest    # read the latest day from QONQR's drop

cd ../transform && uv run dbt build     # ~25 s over 9.88M events
cd ../pipeline  && uv run python -m znhstry export
```

`restore` first: the daily drop is a 31-slot ring covering the last month, so it cannot
rebuild a record that starts in 2012.

## Data source

QONQR publishes its own zone data to a public Dropbox folder — 31 rotating daily CSVs plus
country and region lookups. That is the only live source this project reads.

Battle report history was seeded once from the long-running community scrape at
[neon-ninja/QONQR_zonedata](https://github.com/neon-ninja/QONQR_zonedata), because the
report-number range is sparse and re-fetching it would have meant roughly 130,000 requests
to the game's own server to recover 61,517 rows.

## Licence

MIT.
