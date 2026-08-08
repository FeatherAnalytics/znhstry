# Continuity: Dropbox ingest cutover

Branch `feat/dropbox-ingest`. **Complete and verified. Not merged — awaiting user testing.**

## Goal

Zone History updates itself from QONQR's own published data and nothing else. All met:

- [x] The nightly makes zero requests to `api-proxy.auckland-cer.cloud.edu.au`
- [x] No dependency on `neon-ninja/QONQR_zonedata` — not its git history, not its MySQL
- [x] The full 9.88M-event history is retained and durably stored off this machine
- [x] `dbt build` and the export still produce a correct site

## What to test before merging

1. `cd pipeline && uv run python -m znhstry ingest` — should read one slot, or say nothing
   to ingest if today's is already in.
2. `cd transform && uv run dbt build` — 30 pass, 2 no-op, ~25 s.
3. `cd web && npm run data` then `npm run dev` — the map against the freshly exported
   `dist/data`. This is the part no automated check covers.
4. Trigger `Nightly data update` manually from the Actions tab. It should restore from the
   Actions cache, ingest, and no-op out if there is nothing new.

## Verification already done

| | |
|---|---|
| Dropbox vs mirror, full ring | 83,870 events both sides, 0 missing either way, 0 value mismatches |
| Repartition to year partitions | 9,878,738 rows both sides, frames identical after sort |
| Final reconciliation vs mirror | every year 2012–2026 exact; 2010 differs by the 1,449,141 all-zero sentinels we skip by design |
| R2 archive round trip | 25 files, 289.9 MB, byte-identical on restore |
| Ingest idempotency | re-run is a no-op; forcing the same slot adds 0 rows |
| Full export | exit 0, 1,930 files, 94.7 MB, every per-tree figure matches the docs |
| Tests | pytest 10 passed, dbt 30/32 (2 no-op), ruff clean |

## Key decisions

- **Fetch one slot per run.** Slot `NN` = day of month, overwritten in place. Target slots
  come from the history on disk, not the calendar, so a missed run heals itself and a gap
  wider than the 31-slot ring raises instead of writing a hole.
- **Year partitions.** The old 88-shard layout sized API responses; nothing sizes them now.
- **R2 holds the raw layer** under `raw/`, in the serving bucket. Both `upload_all` and
  `archive_raw` scope their orphan sweeps so neither can delete the other's objects.
- **Battlestats is a daily leaderboard**, ~10 reports/day from Most Active Zones. Seeded
  once, 61,517 rows; ongoing collection would scrape `portal.qonqr.com`. Modelled but not
  wired into the viewer.
- **No dbt Semantic Layer.** The consumer is precomputed static binaries; there is no
  query-time consumer for it to serve. Exposures, contracts and unit tests fit; it does not.
- **R2 stays on `r2.dev`.** A CDN needs `featheranalytics.dev` on Cloudflare nameservers.
  Public usage has not hit the rate limit, so this is deferred, not forgotten.

## Open

- Battlestats has no viewer feature. `fct_zone_battles` is built, tested, and read by
  nothing. Needs a design conversation about how marks should read against the dots.
- Battlestats stops updating until a `portal.qonqr.com` scraper exists.
- UNCONFIRMED: whether `zones` needs a periodic full refresh. Upserting from daily CSVs
  never sees a correction to a zone that is otherwise quiet.
- `series/country.bin.br` and `series/region.bin.br` still rewrite in full nightly (4.1 MB).

## Working set

- Branch: `feat/dropbox-ingest`, 9 commits, not merged
- New: `ingest.py`, `schema.py`, `dropbox_links.txt`, `pipeline/tests/`,
  `stg_battlestats.sql`, `fct_zone_battles.sql`, `_exposures.yml`, `_unit_tests.yml`,
  `seeds/factions.csv`, two singular tests
- Deleted: `extract.py`, `api.py`, `archive-raw-data.yml`
- Delete this file on merge.
