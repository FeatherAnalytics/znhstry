# Data sources and facts

## Where the data comes from

QONQR publishes its own data to a public Dropbox folder. That is the only live source.
Link list: `pipeline/src/znhstry/dropbox_links.txt`. Full data dictionary:
The column reference is in `pipeline/src/znhstry/schema.py` (dtypes) and the CSV headers themselves.

| | What | Cadence |
|---|---|---|
| `dailyzoneupdates-NN.csv` | every zone that changed that day, 31-slot ring | daily |
| `Countries.csv`, `Regions.csv` | lookups | rarely |
| `portal.qonqr.com` | battle reports, one HTML page per report | ten a day |
| `portal.qonqr.com/Atlantis` | the monthly tournament leaderboard and zone counts | hourly, tournament days only |
| `web.archive.org` | cached copies of the Atlantis page | one-off, 31 snapshots 2019-07 to 2026-06 |

**Slot `NN` is the day of the month and QONQR overwrites it in place.** Nothing in the
filename says which month, so a stale slot is indistinguishable from a fresh one until it
is parsed — slot 03 holding July while slot 01 holds August is the normal resting state in
the first days of a month, not a fault.

**The dump is written just after midnight UTC, so slot `NN` holds all of day `NN` plus the
first seconds of day `NN+1`.** That sliver is load-bearing: it is the only proof that day
`NN` was read completely. `plan_slots` treats a day as finished only when events *after* it
are on disk, because a max date of `NN` alone means slot `NN-1` was the last one read and
`NN` is still a fragment.

**A gap is permanent the moment two missing days need the same slot.** The ring's reach
is the months being wrapped, not a flat 31 days: slots are days of the month, so a window
spanning February needs slots 01–03 twice, and Dropbox only holds the newer month.
`plan_slots` raises on any plan with a duplicate slot number rather than fetching it and
appending the wrong month's events under a successful exit code — counting distinct slots
is exact and subsumes the 31-day case, since any 32 consecutive days repeat one. Restore
from R2 instead. `tests/test_ingest.py` pins the February case.

**Dropbox needs `?dl=1` and answers no freshness question.** Without it you get an HTML
interstitial with a 200 status, which is why `_download` checks the body starts with a
known header rather than trusting the status. There is no `Last-Modified` on the response
and no year in the filename, so "has today landed" costs a full fetch and parse — which is
why the nightly runs once on a timer instead of polling.

**Do not add a third-party mirror.** `neon-ninja/QONQR_zonedata` loads these same CSVs
into a MySQL `changelog` behind a public SQL API, and reading it adds a dependency without
adding data — it is an accumulation of the files above and nothing more. Their git history
is not a fallback either: they force-push, so a shallow clone cannot pull.

### Battle reports are scraped, and the limits are not tuning knobs

`portal.qonqr.com` is the game's own live web server rendering one page per report, not a
bulk endpoint. Collecting from it is tolerated rather than invited, so `portal.py` fetches
**serially**, waits `PORTAL_MIN_INTERVAL` between requests, and only asks for report
numbers it does not already have. A normal run costs one index page and stops.

- **`PORTAL_MAX_PER_RUN` caps a catch-up** so an outage resumes over several runs instead
  of crawling thousands of pages at once. Do not raise it to "just get caught up".
- **Most Active Zones only names today's ten.** Reports from a missed day appear on no
  index anywhere, so the span between what we hold and what is listed is walked by number.
- **A report number with no report is normal.** ~61k real reports span a range of ~131k
  numbers, so misses are counted and stepped over, never raised. Because roughly half the
  range is empty, the walk's progress cannot be read off the reports on disk —
  `data/raw/battlestats/checked_through.txt` records the highest number actually asked
  for, or a batch of dead numbers is re-walked every night forever.
- **A page the parser cannot read is logged by number and skipped, never raised.** One
  moved layout must not discard the 39 other pages a run already paid rate-limited
  requests for.
- **`Date` on a report page is US month-first** — `8/7/2026` is 7 August. Parsed with an
  explicit format, because for any day under 13 the wrong reading is also a valid date and
  the error would be silent and up to eleven months wrong.
- **Numbers use a plain space for thousands** (`1 666`).
- **`Faction` on a per-player row is the player's faction when the page was served, not
  when the battle happened.** The portal renders it from the profile live, so the backfill
  — which walks report numbers descending, a band a night — stamps every row it collects
  with whatever faction each player holds that night. `FetchedAtUtc` records when the claim
  was true; rows written before it exists are null. The report's own header totals are
  historical, which is what makes the disagreement visible: sum the per-player launches by
  row faction and compare against `Legion/Swarm/Faceless Total Launches`. Reports scraped
  near their battle date match exactly; old ones put launches under factions the header
  says never launched at all.
- The parser builds column names from the page's own stat labels and each cell's CSS
  class, which is what makes new rows land in the seeded history's exact 77 columns.
  `pipeline/tests/test_portal.py` pins that contract against a real saved page.

### The Atlantis tournament leaderboard

`portal.qonqr.com/Atlantis` is one page: the monthly tournament's leaderboard, its nineteen
zones, and the month's rules. `uv run python -m znhstry atlantis` reads it and writes four
Parquet tables under `data/raw/atlantis/`, which R2 holds under `raw/atlantis/` —
`restore --prefix atlantis/` pulls them back and `archive --prefix atlantis/` pushes them.

| | Key | Holds |
|---|---|---|
| `leaderboard/year=YYYY/` | `(ObservedAtUtc, Faction, PlayerName)` | launches and the two badges |
| `zones/year=YYYY/` | `(ObservedAtUtc, Zone)` | the three faction counts |
| `zone_months/` | `(Month, Zone)` | the month's zone name and `CubesAllowed` |
| `tournaments/` | `(Month)` | stacking days, battle days, the end |

**The schedule is read off the page, not configured.** A tournament starts 00:00 UTC on the
1st of each month and the page states `Stacking Days: N  Battle Days: M`; the end is start
plus N+M days. The job fetches once an hour while a tournament is running and not at all
between them. The first run at or after the end is the final pull. A `state.json` beside the
data carries `next_run_at`, and the workflow's gate reads it from the public bucket before
deciding whether to run, so an idle hour costs one small read and no request to the game.
The gate fails the run when `DATA_ORIGIN` is unset or the state file returns anything but
200 or 404, so a broken origin cannot turn into an hourly scrape between tournaments.

**A Cloudflare Worker dispatches the hourly workflow, because GitHub's scheduler does not.**
GitHub's cron skipped the Atlantis schedule outright for hours at a time and runs the nightly
about five hours late; Cloudflare cron triggers fire on time. `trigger/` is a Worker whose
`scheduled` handler calls `workflow_dispatch` on `atlantis.yml` at :07 and on `nightly.yml`
at 00:45 UTC, deployed by `deploy-trigger.yml`. Both workflows keep their own `schedule:`
as the fallback and a doubled run is a no-op in each: the Atlantis gate reads `next_run_at`,
the top of the hour after a collection, so the second run of an hour reads `run=false`; the
nightly's `plan_slots` asks only for missing days and "Anything to publish?" skips the
rebuild when nothing is new. The Worker's `GITHUB_TOKEN` is a fine-grained token with Actions:
Read and write on this repository, pushed from the repository secret
`ATLANTIS_DISPATCH_TOKEN` on every deploy. It has no expiry; rotating it is replacing that
secret and re-running `deploy-trigger.yml`.

**The hourly job and `wayback.yml` are the two writers of `raw/atlantis/`.** Both share the `atlantis` concurrency group so they never run in parallel. A full `archive` with no `--prefix` neither uploads nor sweeps that subtree, so a laptop or the nightly holding a stale copy cannot overwrite an hour of rows or delete keys it never fetched.

**The banner names the winner, and only after the end.** During the battle the page's
`main-banner` h1 reads "The battle for Atlantis is under way."; afterwards it reads "The
Swarm are victorious!" over "The battle for Atlantis has ended.", and the page keeps the
final board and the schedule under that banner until the next tournament starts. `Winner`
in `tournaments/` is parsed from it and is null on every row written during the battle. A
forced run after the final pull writes only the tournaments row, so it backfills the winner
without recording the post-tournament board as part of the battle.

**Launch counts reset to zero each month, and a player can appear under more than one
faction in a month.** That is why faction is in the leaderboard key. Rank is not stored; it
is derived, with ties sharing a rank the way the site shows them.

**`Zone` is a stable position key, never the site's name.** `Prime`, then `Legion 1`..`6`,
`Swarm 1`..`6`, `Faceless 1`..`6`, numbered from the apex of each faction's triangle, left
to right, top to bottom. Positions 1-3 are named after players and change monthly; 4-6 are
formation zones like `L DEF SHOCK` whose names can also change. The site's name for the
month is `ZoneName` in `zone_months`. The triangle's faction is read from the letter prefix
on its formation zones, not from position.

- **`TournamentMillionKills`** is the page's `atlantis-gold` badge: 1,000,000+ kills in
  the current tournament. **`WeeklyMillionKills`** is the `gold-star` badge: 1,000,000+
  kills this week outside the tournament, where weeks start 00:00 UTC Sunday.
- **`CubesAllowed`** is true when the zone's rule text that month says use of refresh and
  recharge is allowed. Rules are per position, so `Swarm 1` and `Legion 1` share one.
- **Counts use a plain space for thousands**, the same as the battle reports.
- **One request an hour and no retries in a run.** It is the game's live server.

**`Source` is `'portal'` for rows from the live page and `'wayback'` for rows from the Internet Archive.** The `wayback` command is rerunnable; the merge is keyed so re-ingesting a snapshot is a no-op. Formation zones in 2021-era snapshots were named `Swarm Grunt`, `Legion Melee` etc. rather than `S DEF SHOCK`; `_triangle_faction` recognizes both the letter prefix and the full faction-word prefix. When a triangle has no formation zone (every December so far, and 2021-01) the faction is read from the page's own leaderboard, unanimously over at least three of its six names. A wayback month has one observation per snapshot, so it has no intervals.

### Atlantis marts

Nine marts built from the staging views above, plus three derived-history marts from battle reports. All materialized as tables.

| | Grain | Sort key |
|---|---|---|
| `fct_atlantis_player_interval` | player + faction + pair of consecutive observations | `(tournament_month, faction, player_name, observed_at)` |
| `fct_atlantis_faction_hourly` | faction + observation with at least one interval | `(tournament_month, faction, observed_at)` |
| `fct_atlantis_zone_interval` | zone + pair of consecutive observations | `(tournament_month, zone, observed_at)` |
| `dim_atlantis_tournament` | one row per tournament month | `(tournament_month)` |
| `fct_atlantis_payout` | player + faction at the last observation | `(tournament_month, faction, player_name)` |
| `fct_atlantis_zone_player_daily` | player + zone + day from battle reports | `(battle_date, battle_report_number, rank, player_name)` |
| `dim_atlantis_tournament_derived` | one row per report month | `(tournament_month)` |
| `fct_atlantis_player_month_derived` | player + attributed faction per month | `(tournament_month, faction, player_name)` |
| `fct_atlantis_zone_month_derived` | zone name + triangle per month | `(tournament_month, triangle, zone_name)` |

**Placement rule (the game's own).** Rank the three factions by zones held at the last observation, where a zone's holder is the faction with the largest count (ties break Legion > Swarm > Faceless, matching `export.py`'s `_leader`; a tie has not occurred in the data and cannot be resolved from it). When two factions hold the same number of zones, the one holding Prime ranks higher; if neither holds Prime, total bots across all nineteen zones breaks it.

**Payout rule.** The game divides each placement's pool across the faction proportionally to launches. Pool amounts live in the `atlantis_pools` seed as an as-of table keyed by `effective_from`; a month with different pools is one appended row. The current pools are 10,000,000 / 4,000,000 / 1,000,000 for first / second / third.

**Faction attribution (`znhstry attribute`).** A pipeline step that writes `data/raw/battlestats/player_factions/rows.parquet`, keyed `(Month, PlayerName)`, with `Faction`, `FactionSource`, `IsMercenary`, `MercenaryEvidence`. Runs in the nightly after `battlestats` and before `dbt build`. Per player-month the faction is the first hit in a five-step precedence chain: (a) the month's board where one exists (`FactionSource = 'board'`), (b) an override seed (`'override'`), (c) the report's own launch totals (`'report-totals'`), (d) zone-name evidence from the next month's triangle (`'zone-name'`), (e) the player's scraped faction (`'scraped'`). Mercenary detection runs separately over the results: `same-month` (two factions in one month, from the board or the report totals), `zone-names` (named a zone in another faction's triangle), `across-months` (different confirmed factions across months). Players without an attribution row get `Unconfirmed` in the mart.

**`report-totals` is the only per-battle faction evidence the page preserves.** A report whose header shows exactly one faction with launches was fought by that faction alone, so everyone who launched in it was of that faction — and unlike the row's own `Faction`, those totals are stored with the battle rather than rendered from a profile when the page is served. It covers 21,075 player-months against the board's 6,291, and where both exist they agree on 3,838 of 3,871 (99.1%); the 33 that differ are months where the board records whose leaderboard a player scored on and the totals record what they actually launched, which for a mercenary are different questions with different true answers. Ambiguous months — a player launching in single-faction reports of two different factions, 175 of them — fall through to the next rung and are flagged `same-month` instead.

**The scraped rung never feeds mercenary detection.** The backfill walks report numbers descending, a band a night, so a player who changes faction between two nights has their history split at that band. Reading that split as switching would flag the collection rather than the player.

**Interval grain.** A player's first observation in a month yields no interval row. `launches_gained` is never negative in the data; it is kept as is, not clamped. `launches_per_hour` is `launches_gained / minutes * 60`, where `minutes` is the gap between consecutive observations. The page says "per hour" and never "per minute".

## Data facts (measured, not guessed)

- **The record starts at release, 2012-07-30.** `config.RECORD_START`. Everything before
  it is pre-release testing — 11 scattered events from 2012-05-19 to 07-29, plus the 29
  backfill sentinel rows dated 2010-01-01 — so "All time" means the life of the game
  rather than the life of the table. The cut is one `zone_events` view that every export
  query reads instead of `fct_zone_events`; there are 12 such queries and filtering each
  would drift. The warehouse keeps the full record, so this is reversible.
  Cost: 40 events across 40 zones, 7 of which stop counting as ever-played.
- **`changelog` is a sparse event stream.** A row exists only when a zone's counts or
  control state changed. ~10M events and growing, ~2,000–3,100 a day.
- **Carry-forward is the core modelling problem.** 504,410 zones (32% of those ever active)
  last changed in 2019 or earlier. Any time-window slice that ignores older events loses
  their state entirely.
- **Pre-2012 rows are backfill sentinels.** 1,449,170 of them, of which only **29** carry
  any bots. Everything else is genuinely zero, so pre-first-event state is treated as zero.
  Those 29 live in `changelog/year=2010/` and are the whole of the starting state.
- **Before late 2018 the changelog is a thin stream of first sightings, not the game's
  history.** Zone-days with any predecessor: **1 in 2017**, 39,698 in 2018, then over a
  million a year. So for 2012–2017 almost every row is a zone's first ever observation and
  essentially nothing can be seen to *change*.

  Zones by year of first event ramp 1,311 (2012) → 356,228 (2017) → **475,582 (2018)**, then
  fall to roughly 50k a year. Part of that rise is real — first sightings step from ~22k a
  month through April 2017 to ~34k from May and hold, right after the in-game missile range
  increase — and part is plainly collection: the Sept–Oct 2018 months alone run 79,626 then
  20,954 then 6,953.

  **MAZ proves the early record is incomplete rather than quiet**, the same way it does for
  2019. Battle reports landing on zones with no changelog state yet: **100% in 2014** (3,568
  of 3,568), 3,609 of 3,617 in 2017, and **zero from 2019 on**. The Dallas–Fort Worth box
  holds 315 zones with no event before 2018 and all 315 first seen in Sept/Oct 2018, while
  MAZ has them among the most active zones in the world from January 2014 — Watauga is
  reported on 2014-01-01 and enters the changelog on 2018-09-22.

  The practical consequence: **"uncaptured became captured" is not answerable before late
  2018.** Over 2017-04-01 to 2019-12-31 there are 4,730 conversions we actually witnessed —
  seen empty first, then held — against 817,344 zones whose first row of any kind falls
  inside the window, and none of the 4,730 land before October 2018. Anything counting new
  captures in that period is counting the crawler. Say "first seen holding bots", never
  "captured". Not recoverable: the ring reaches back 31 days and these are 2014–2017 slots.
- **2019's gap is a collection artifact, and battlestats proves it**: 337,859 events vs
  627,035 in 2018 and 1,438,855 in 2020 — but **5,159 battle reports in 2019**, flat against
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
- **A region is not a subset of its country, and that is the game's own model.** For 447
  zones the region they point at belongs to a different country, and coordinates back the
  country every time: 155 zones pointing at West Pomeranian Voivodeship (Poland) sit at
  162°E, -10° in the Solomon Islands; 135 pointing at Northwest Territories (Canada) are in
  the DRC; likewise Tonga↔Azerbaijan (87) and East Timor↔Ukraine (68).

  **The `regions` table is not at fault** — it is correct, and identical in `Regions.csv`
  and the SQL mirror (3,799 rows, same values). The proof is Kingston, Norfolk Island
  (zone 27425): region 3869 is `Islands` under Norfolk Island and is right there in the
  table, but the zone points at 3868, `Islands` under South Georgia. The game renders
  "Islands" regardless, so the two share a name and the error is invisible in-game.

  Only that one zone is recoverable by matching the region name under the correct country.
  The other 446 point at a region whose name exists nowhere under their country — the
  Solomon Islands zones point at 2452 when that country's regions are 2746–2753, so it is
  wholesale wrong rather than off by one. Not worth a repair rule that fires once.

  **QONQR's own site counts a country by `CountryId` and a region by `RegionId`,
  independently, and we match it.** Their figures: Poland 44,080 zones, West Pomeranian
  Voivodeship 1,890, Northwest Territories 198. The first comes from `CountryId` and the
  other two from `RegionId` alone, contradicted zones included. So the region ids are the
  game's real state rather than an import artifact, and its hierarchy genuinely files a
  zone at 162°E in the Solomon Islands under a Polish voivodeship.

  **The cost is that regions do not sum to their country**, and anything presenting them
  as a partition has to say so:

  | Country | By `CountryId` | Its regions by `RegionId` |
  |---|---|---|
  | Poland | 44,080 | 44,235 |
  | Ukraine | 26,105 | 26,173 |
  | Canada | 7,688 | 7,823 |
  | Azerbaijan | 4,647 | 4,734 |
  | Solomon Islands | 2,736 | 2,581 |
  | DR Congo | 21,443 | 21,308 |

  Selecting Northwest Territories therefore draws 198 zones across Canada and the Congo,
  and the camera frames both. That is strange to look at and is what the game says. The
  alternative — a total no player can reconcile against their own screen — is worse than a
  region that reaches across an ocean.

  The data dictionary documents both join paths as equivalent. They are not, and neither
  is a correction of the other: `CountryId` answers "where is this zone", `RegionId`
  answers "which region does the game file it under", and a query has to know which
  question it is asking.
- **`battlestats` column names contain spaces** and need backticks.
  `Country = 'Atlantis'` marks **tournament** zones — see below. Not test data.
- **Battlestats is a daily leaderboard, not a log of every fight.** QONQR publishes a fixed
  number of reports a day from its Most Active Zones page: exactly 10 on 3,451 of the 4,598
  covered days, 27–29 on most of the rest. A row means *this zone was among the most active
  in the world that day* — never relabel it "battles that day", which would imply the other
  ~3,000 active zones were quiet. No zone is reported twice in a day, so battle grain and
  zone-day grain coincide. Coverage starts 2014-01-01, eighteen months after release.
- **`players` counts faction-player pairs, not people.** A player who launched for two
  factions in the same zone on the same day is counted once under each, so the header
  count can exceed the number of distinct handles in the report's own player list — report
  131137 says 4 players and lists 3. Say "active players" and never "people", and treat any
  per-player count derived from `players` as an upper bound.

  This is **not** the 2019 faction-split fault, and conflating the two will send someone
  down the wrong road. That one is a shortfall — the header total is *higher* than the three
  faction columns, on 861 reports between 2019-07-01 and 2019-09-11. Faction switching
  pushes the other way: the faction columns and the header agree with each other, and it is
  the distinct-handle count that comes out lower.

  Unverifiable from what we collect. The per-player list is a packed string on the report
  page that ingest does not unpack, so nothing in `data/raw` holds the names to count.
  See `thoughts/future-features.md`.
- **Atlantis is the tournament world, and its reports are real.** 15,837 of the 61,517, over
  2,812 tournament zones from 2014-06-06 onward, and they carry the heaviest fighting in
  the game — a median 36 active players against 6 for a mapped zone. Do not treat them as
  test or tutorial data.

  A tournament report is shaped differently and every field has to be read accordingly:
  **`Zone ID` is negative**, `Region` holds the owning faction (Central, Legion, Swarm,
  Faceless) rather than a place, and `Zone Name` is a player handle. None of them join
  `dim_zone` and none have coordinates.

  The negative id is the discriminator — exact and total, all 15,837 have one and no other
  report does, guarded by `tests/assert_tournament_zones_are_negative_ids.sql`.
  `fct_zone_battles` excludes them because it is a geographic model with nowhere to draw
  them, **not** because they are noise. Anything counting all battle reports reads
  `stg_battlestats`.
- Per-player data (`battlestats_players.csv`, `player_details.csv`) exists only in the
  community scrape and is not collected here.

### changelog does not perfectly reconcile to zones

Cumulative deltas from `changelog` land slightly above the `zones` table. The gap comes
from **~1,429 zones (0.09%)** whose last event disagrees with their `zones` row, always
with the event higher. Both come from the same daily CSV, so this is the game's own drift
rather than a mirror's two-step import, and it is expected to persist.

Three zones (`2836390`, `2836391`, `2836392`) formerly existed in `changelog` but not in
`zones`, contributing 722,697 Swarm bots to the gap. QONQR's `zones.csv` added them
around 2026-08-25, so they now join `dim_zone` normally and the gap has narrowed.
`fct_zone_events` still left-joins `dim_zone` so any future orphans land with a null
`country_id` rather than being dropped.

The remaining gap is immaterial for a visualization. It is documented rather than tested
against a threshold, because thresholds on upstream drift are brittle.

