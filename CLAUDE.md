# znhstry (Zone History)

Historical visualization of QONQR zone control: where every zone stands, what moved over
any window, and how the whole thing got here. QONQR's published CSV drop -> Parquet ->
dbt/DuckDB -> deck.gl dashboard.

**Slug is `znhstry`; display name is "Zone History".** Use the display name in page titles,
headings, and prose. The slug is for the repo, URL, and package only.

**This repo is self-contained.** It reads QONQR's own published data and nothing else — no
third-party mirror, no other repository, no server that belongs to a person rather than the
game — with one exception: the Internet Archive's cached copies of QONQR's own Atlantis page, which are that page verbatim rather than a mirror's reprocessing. See "Where the data comes from".

## Tech Stack

- **Python** 3.13+, managed by `uv`. Type hints on functions. Lint with `ruff`.
- **Ingest**: `httpx` + `polars` -> Parquet in `data/raw/`.
- **Transform**: dbt-duckdb in `transform/`. `uv run dbt build` takes ~25 s. Run `dbt ls` for current model and test counts.
- **Export**: `pipeline/` slices the marts into static binaries under `dist/data/global/`.
- **Web**: Next.js static export + deck.gl, in `web/`.
- **Hosting**: the site at `znhstry.com` as Cloudflare Workers static assets (`wrangler.jsonc`),
  the data in Cloudflare R2 at `data.znhstry.com`. Two deployments.

## Commands

The refresh chain is these steps, in order — exporting without rebuilding the warehouse ships whatever the marts last held:

```bash
cd pipeline  && uv run python -m znhstry ingest       # read the day's slot from Dropbox
cd pipeline  && uv run python -m znhstry battlestats  # scrape any new battle reports
cd pipeline  && uv run python -m znhstry attribute    # attribute factions to battle-report players
cd transform && uv run dbt build                      # rebuild the marts (~25 s)
cd pipeline  && uv run python -m znhstry export       # rebuild dist/data (~3 min threaded)
cd pipeline  && uv run python -m znhstry upload       # push changed objects to R2
cd pipeline  && uv run python -m znhstry marts        # write the marts as Parquet to dist/marts
cd pipeline  && uv run python -m znhstry upload --marts  # push them to R2 under marts/
cd pipeline  && uv run python -m znhstry archive      # push data/raw to R2 under raw/
```

**The nightly is started at 00:45 UTC by a Cloudflare Worker in `trigger/`, and the hourly
Atlantis job at :07 by the same Worker.** GitHub's own `schedule:` lines stay as fallbacks;
GitHub has been firing the 02:30 cron around 07:20 and dropping the hourly one entirely. See
"The Atlantis tournament leaderboard" for why a doubled run is a no-op in both.

Other steps:

```bash
cd pipeline
uv run python -m znhstry restore          # pull data/raw back from R2 — first step on a clone, no key needed
uv run python -m znhstry atlantis         # pull the tournament page if a tournament is running
uv run python -m znhstry wayback          # ingest archived Atlantis snapshots from the Internet Archive
uv run python -m znhstry backfill         # re-fetch historical battle report pages for per-player rows
uv run python -m znhstry ingest --slots 7 # force specific ring slots (day of month)
uv run python -m znhstry boundaries       # rebuild the admin outlines
uv run python -m znhstry export --only atlantis  # rebuild only atlantis/; requires an existing meta.json from a full export

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

Machine-specific traps and the workarounds for them live in `thoughts/HANDOFF.md`, which is
gitignored. This file documents what the project *is*; that one documents what is currently
sore about working on it.


See [docs/viewer.md](docs/viewer.md) for the viewer architecture.

See [docs/data.md](docs/data.md) for data sources, battle reports, Atlantis tournament, and measured data facts.

### Invariants — each one has a failure mode that is silent

- **Never mistake a day's first sliver for the whole day.** A slot spans midnight, so
  having events *dated* day D usually means slot D-1 was read and D is a fragment. Deciding
  completeness by comparing dates skips D forever. `plan_slots` requires events strictly
  after D, and `tests/test_ingest.py` pins it. Never assume a thin final day is real.
- **`fct_zone_checkpoints` must compare timestamps, not dates.** Casting to date drops every
  boundary an event lands on — the preceding event fails `next > B` and the event itself
  fails `B > observed`, so no row matches, and 19,062 checkpoints vanish.
  `tests/assert_one_checkpoint_per_zone_boundary.sql` guards it.
- **Join regions on `region_id` alone, and never add `country_id` to make it tidy.** Adding
  it drops 447 zones from their regions and puts every region total 155, 135, 87 or 68
  below what QONQR's own site reports — a number a player can read off their screen and we
  cannot match. The contradictory pairing it prevents ("Solomon Islands / West Pomeranian
  Voivodeship") is upstream's, not ours.
  `tests/assert_region_membership_matches_the_game.sql` fails if a zone with a `region_id`
  ever loses its label.
- **Do not hardcode a max ZoneId.** New zones appear above the previous maximum. Ingest
  discovers them because they arrive in the daily CSVs like any other change.
- **Every input to a deck.gl binary attribute belongs in its `updateTriggers`.** `ZoneMap`
  mutates `colors` and `radii` in place, and deck.gl cannot see a mutation — only a changed
  trigger makes it re-upload. Listing the date but not the focus mask, the empty-zone mode or
  the emphasis means dimming an area silently stops repainting the map. It is invisible while
  anything else happens to rebuild the `data` object every render, and appears the moment that
  is memoised. For a binary attribute the `data` object's *identity* is the only thing deck.gl
  watches, so the same input also belongs in that memo's dependencies: writing the fill loop
  and forgetting the memo repaints the panel and leaves the dots alone.
- **Format every date with `timeZone: "UTC"`.** A day is a UTC date, and `toLocaleDateString`
  without it renders in the reader's own zone — one day earlier everywhere west of UTC, which
  reads as the playhead disagreeing with the panel rather than as a formatting fault, and is
  invisible to anyone developing at GMT or east of it.
- **A bbox prefilter must never be tighter than the circle it precedes.** 111.32 km per
  degree of latitude is a mid-latitude average; a real degree is shorter, so an unpadded box
  is narrower than its radius and clips edge zones before haversine runs.
  `BBOX_MARGIN = 1.05` in `distance.py`.
- **Guard packed integer columns for overflow and sign — every one of them.** `day` is a
  uint16 offset from `DAY_EPOCH` (2010-01-01, chosen so the 29 backfill sentinel rows are
  not negative); an earlier row would underflow into a plausible-looking date rather than
  failing. Which columns "can" overflow is a judgment that goes stale the moment upstream
  widens a field, so `_pack` bounds-checks all of them. It also rejects masked arrays:
  DuckDB returns one for any column that carried nulls, `np.asarray` drops the mask, and
  the null ships as a zero — a null country reads as country 0 everywhere downstream. A
  null must be resolved in the query, coalesced or dropped.
- **Integer division in DuckDB is `//`; `cast(a / b as integer)` rounds.**
  `cast(6144 / 4096 as integer)` is 2, not 1. On block arithmetic that writes a spurious
  empty block past the end of the index and can skip a block whose rows all sit in its
  upper half — 4,096 zones whose history silently never lands on disk.
- **Upload order: shards, then manifests, then the orphan sweep.** Until the new manifest
  lands, clients read the old one, and the old one names exactly the keys the sweep
  removes. `upload_all` also refuses to run when any shard is newer than the `meta.json`
  that has to describe it — an export that died part way leaves fresh trees under a stale
  manifest, and uploading that deletes live objects.
- **`export_all` writes the boundary payloads itself.** The upload sweeps every bucket key
  the data directory does not contain, so anything only a separate command writes is
  deleted from R2 on the next nightly — and the viewer swallows the missing file, so the
  outlines just vanish. The standalone `boundaries` command exists to *refresh* them.
- **A rejected fetch must not stay in an in-flight cache.** `displayWorker.ts`, `names.ts`,
  `zoneHistory.ts` and `series.ts` all dedup concurrent requests through a promise map; evict on
  rejection or one transient failure makes that year, name block, or history block
  unloadable for the life of the page. The display error is likewise cleared when the next
  answer arrives — recovery is expected, and a banner left standing over a working map
  reads as the map being wrong.
- **`ZoneMap`'s patch key carries the focus mask's identity, not its presence.** The
  incremental repaint skips every row whose bytes did not move, so a key that only says "a
  filter exists" leaves the first area's dimming on screen when the reader picks a second
  one. Near-me ↔ area transitions are the ones that expose it.
- **`paint/` bytes apply only while the display stands at the newest date with no window
  open.** They are the newest standings; a tile landing after a scrub would otherwise
  paint today's colors onto a historical map, and nothing re-asks for a date when a tile
  lands. `useZoneData` gates this and re-asks the worker on the repaint beat instead.
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
- **Every file behind the `battlestats/players/` glob carries the same columns in the same
  order.** DuckDB takes its schema from the first file it reads, so a column the others add
  is dropped without a word, and a column only the first one has fails the read outright;
  polars refuses the scan either way. A column added to `_PLAYER_SCHEMA` therefore has to
  reach the files already on disk. `ensure_players_table` aligns them and runs before every
  scrape and in CI, so a fresh `restore` from a bucket written before the column existed
  heals itself rather than failing at 02:30 UTC.
- `matched` is a reserved word in DuckDB. Don't use it as a column alias.


See [docs/export.md](docs/export.md) for the export format, raw layer, and published marts.

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
- **A pull request that changes published bytes carries the `republish` label.** The
  nightly's gate asks whether new events arrived, not whether the shape of what we publish
  moved, so an output change merged on a quiet night sits unpublished behind a manifest
  that predates it. The label makes `republish.yml` dispatch the nightly with
  `republish: true` on merge. Use it for the export format, mart values and the derived
  history; not for a change confined to the raw layer, which the next archive carries on
  its own, and not for the viewer, which `deploy.yml` deploys.
- **American English everywhere.** UI strings, code comments, docs, commit messages: color,
  gray, meter, behavior, normalize, analyze. Not colour, grey, metre, behaviour, normalise.
  This file and parts of the codebase still carry British spellings from earlier work; fix
  them as you touch them rather than in one sweep.
- Testing is deliberately concentrated where failures are invisible, not spread evenly.
  dbt carries generic data tests, singular tests and a unit test; `pipeline/tests/`
  covers the ring arithmetic and the dtype contract, which decide what gets written before
  dbt can see it. The viewer has ESLint (`eslint-config-next` core-web-vitals) and `npm run lint`; `react-hooks/exhaustive-deps` is the automated check for the `updateTriggers`/memo-deps invariant CLAUDE.md maintains by hand. **CI restores the raw layer without a key and runs
  `dbt build` on every pull request**, so a source bound to a glob that does not exist
  fails before merge rather than at 02:30 UTC. `dbt source freshness` warns at 2 days stale and
  errors at 7 — well inside the 31-day ring, so there is time to act before a gap becomes
  unrecoverable. **The nightly runs it right after ingest and fails red on error.** That
  step is the only alarm that fires while the missing days are still fetchable — without
  it a quiet upstream is a green no-op every night until the ring closes over the gap. Do
  not remove or `continue-on-error` it.
