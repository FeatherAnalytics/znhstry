# Zone History

A historical dashboard for [QONQR](https://qonqr.com) zone control — how territory and bot
counts changed over fourteen years, globally and locally.

Most maps of this data show the present. This one shows the past: scrub to any date, compare
a period against the one before it, and watch faction control shift across a region.

**Status:** early. Extraction works; modelling and dashboard are next.

## Why it's interesting to build

The source is an append-only event stream — a row exists only when a zone actually changed.
That makes "what did the map look like on this date?" surprisingly hard:

- **32% of ever-active zones last changed in 2019 or earlier.** Slice history by a recent
  time window and you silently lose half a million zones that still hold territory.
- Reconstructing dense daily state naively means 2.7M zones x 5,100 days = 13.7 billion
  cells. Cumulative-summing per-event deltas instead makes it linear in events (9.87M).
- Volume is uneven by an order of magnitude across years, so extraction chunks adaptively.

## Architecture

```
QONQR SQL mirror  ->  Parquet (data/raw)  ->  dbt-duckdb  ->  static exports  ->  Next.js + deck.gl
```

| Layer | Tool |
|---|---|
| Extract | Python 3.13, `httpx`, `polars` |
| Warehouse | DuckDB |
| Transform | dbt-duckdb |
| Web | Next.js static export, deck.gl, D3 |
| Host | GitHub Pages |

Data is extracted once and owned locally; the upstream API is then only needed for nightly
incremental top-ups.

## Running the pipeline

```bash
cd pipeline
uv sync
uv run python -m znhstry all
```

Idempotent and resumable — re-running skips any chunk already on disk. The full extraction is
roughly 9.9M events and takes well under an hour.

## Data source

Public read-only mirror of QONQR game data maintained by
[neon-ninja/QONQR_zonedata](https://github.com/neon-ninja/QONQR_zonedata) at the University of
Auckland Centre for eResearch. The extractor stays deliberately gentle with it: 3 concurrent
requests, a half-second floor between them, and an identifying User-Agent.

## Licence

MIT.
