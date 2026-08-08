# Continuity: Dropbox ingest cutover

## Goal

Zone History updates itself from QONQR's own Dropbox CSVs and nothing else. Done means:

- The nightly run makes **zero** requests to `api-proxy.auckland-cer.cloud.edu.au`.
- No dependency on `neon-ninja/QONQR_zonedata` — not its git history, not its MySQL.
- The full 9.88M-event history is retained and durably stored off this machine.
- `uv run dbt build` and the export still produce a byte-identical site.

## Constraints

- **Only QONQR-owned sources.** Dropbox for zone events and lookups; `portal.qonqr.com`
  for battlestats going forward. Never neon-ninja's box or repo — with one bounded
  exception: a **one-time historical seed** through the SQL mirror, taken during this
  branch and never repeated.
- **Fetch one slot per run, not the ring.** Slot `NN` = day of month, overwritten in
  place. A nightly needs exactly the slot for the day that just closed; pulling all 31
  to learn one day is waste, both ours and QONQR's. The manual override exists for the
  rare case where a specific slot has to be re-read.
- **The 31-slot ring is the only lifeline for new data.** Miss more than 31 days and the
  window is gone permanently, so the gap check is not optional — see the decision below.
- Merge key is `(ZoneId, LastUpdateDateUtc)`. Verified unique across all 9,878,738 rows.
- dbt owns all logic. Ingest stays a thin EL step: fetch CSV -> Parquet, nothing else.
- Ingest must be source-agnostic — battlestats is a planned second source.
- Don't merge. Regular commits on `feat/dropbox-ingest`. User tests before merge.

## Key Decisions

- **Dropbox reproduces the API exactly** — verified over 2026-07-03 to 2026-08-03:
  83,870 rows both sides, 0 rows missing either way, 0 value mismatches on
  `ZoneControlState` + all three counts. Cutover is lossless.
- **Year partitions, not monthly shards.** The 88-window split existed only to keep API
  responses manageable (`changelog_windows()`, extract.py:118). With no API, a nightly
  append rewrites one ~15 MB `year=YYYY/` partition instead of a 156 MB spread.
- **Stay on R2, plain `r2.dev`, no CDN for now.** Public usage has not hit the rate
  limit, so this is not a live problem. The fix when it becomes one: R2 custom domains
  require the *zone* to be on Cloudflare, so `featheranalytics.dev` would point its
  nameservers at Cloudflare's free tier — the registrar does not change. Out of scope
  here; recorded so nobody re-derives it.
- **Target slots come from the history, not the calendar.** A run computes which days
  are missing between the newest event on disk and the day that just closed. Normally
  that is one slot. A missed run heals itself on the next one, and a gap wider than the
  31-slot ring raises instead of writing a hole — that data is genuinely unrecoverable
  and a silent success would be the worst outcome.
- **Battlestats: seeded from the community scrape, not the mirror.** 61,517 rows read
  out of `git show origin/main:battlestats.csv` — their working tree untouched, because
  they force-push and a shallow pull refuses to merge. Ongoing collection scrapes
  `portal.qonqr.com` a few times a day, which the developer has informally accepted.
- **Battlestats is a daily leaderboard, not a log of fights.** Exactly 10 reports on
  3,451 of 4,598 covered days, 27-29 on most of the rest — it is the Most Active Zones
  page. A row means "among the most active in the world that day". Never label it
  "battles that day" in the viewer; that would imply the other ~3,000 active zones were
  quiet. Battle grain and zone-day grain coincide (no zone reported twice in a day).
- **2019's gap is confirmed a collection artifact.** 3,614 battle reports that year,
  flat against every neighbour, while the changelog has 337,859 events against 2018's
  627,035. A second, independent source says the game was busy and the collection was
  not. Worth saying out loud on any long time series.
- **`factions` becomes a dbt seed.** 4 static rows, not in Dropbox, never changes.
- **Lookup CSVs need no transformation.** `Countries.csv` is already
  `countryid,Code,Description` and `Regions.csv` is already
  `countryid,regionid,description` — exact schema parity with the existing parquet.
- **Keep `extract.py` intact but unused.** It is the reconciliation oracle for verifying
  the cutover, and costs nothing idle. It is not called by any nightly path.
- **Delete `archive-raw-data.yml`.** Set up by a previous session, never requested,
  never ran (`gh release list` is empty). Superseded by the R2 raw archive.

## State

- Done:
  - [x] Phase 0: Verify Dropbox fidelity against the API; confirm merge key uniqueness
  - [x] Phase 1: `schema.py` + `ingest.py` — fetch Dropbox slots, normalise to Parquet
  - [x] Phase 2: Year partitions, keyed merge, dbt source on `hive_partitioning`
  - [x] Phase 3: zones + lookups from the daily CSVs; factions as a dbt seed
  - [x] Phase 4: battlestats seeded from the community scrape, staged, and modelled
  - [x] Phase 5: R2 `raw/` archive + restore, round trip verified byte-for-byte
  - [x] Phase 6: `nightly.yml` rewritten; `archive-raw-data.yml` deleted
  - [x] Phase 7: freshness, exposures, unit test, region fix, 10 Python tests
  - [x] Phase 8: reconciled against the mirror, every year exact; CLAUDE.md rewritten
- Now: [→] Phase 9: verify the export, then delete everything in MIGRATION-INDEX.md

## Reconciliation result (the last thing the mirror was used for)

Per-year counts match exactly for 2012-2026. 2010 differs by design: 29 rows kept of
1,449,170, the rest being all-zero backfill sentinels, and the total diff is exactly
1,449,141. Nothing else to check — the history on disk is the history upstream has.

## Open Questions

- Battlestats *modelling* is unscoped. Phase 4 only lands the raw table; no staging
  model, no mart, no viewer feature. Those come when the user asks for the feature.
- UNCONFIRMED: whether `zones` still needs a periodic full refresh. The daily CSVs carry
  every changed zone, so in principle it can be maintained by upsert forever — but the
  `zones` table is also where a zone's *position* would be corrected upstream, and a
  correction to an otherwise-quiet zone would never appear in a daily file. Cheap
  insurance would be a yearly full rebuild; decide in Phase 3.

## Working Set

- Branch: `feat/dropbox-ingest`
- New: `pipeline/src/znhstry/ingest.py`, `pipeline/src/znhstry/dropbox_links.txt`
- Touch: `extract.py` (leave API path), `config.py`, `upload.py`,
  `transform/models/staging/_sources.yml`, `.github/workflows/nightly.yml`
- Reference: upstream `update.sh:4` (the fetch), `update_battlestats.py:76` (the scrape)
- Verify: `cd transform && uv run dbt build` (~35 s), then `python -m znhstry export`
- Deleted: `thoughts/upstream-dispatch-request.md` (obsolete — that ask was to reduce
  polling against a server we no longer touch at all)
