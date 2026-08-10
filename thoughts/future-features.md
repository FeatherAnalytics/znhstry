# Future features

Ideas with enough substance to be worth keeping. Nothing here is a commitment or a plan —
it is a place to put things so they stop occupying a conversation. Entries marked **built**
stay, for the reasoning rather than the idea.

**Terminology: these are MAZ — Most Active Zones.** That is the in-game name and the
right one to use in the UI, in models, and in prose. "Battle reports" is what the pages
are called; the *thing* is a MAZ.

---

## What already exists to build on

Everything below reads data that is already collected. No new source is needed.

| | Where | Size |
|---|---|---|
| MAZ reports | `stg_battlestats` | 61,517 back to 2014-01-01, ~10/day |
| Mapped MAZ | `fct_zone_battles` | 45,675 over 11,721 zones |
| Tournament MAZ | `stg_battlestats where is_tournament` | 15,837 over 2,812 zones, from 2014-06-06 |
| Player rows | `players` column, one packed string per report | ~924,728 when unpacked |
| Per-report metrics | `maz_stats.bin.br`, exported nightly | 45,685 rows, row-aligned with `maz.bin.br` |

**The tournament record does not need starting — it goes back to 2014-06-06** and runs
steady at roughly 1,150–1,700 reports a year. What does *not* exist anywhere, in any
source, is a changelog equivalent for tournament zones: negative zone ids appear in zero
rows of `fct_zone_events` and zero rows of `dim_zone`. So tournaments can only ever be
seen through the daily top-N snapshot, never reconstructed as continuous zone state the
way the world map is.

---

## 1. Unpack the player data

Already in the raw layer, one packed string per report. Five fields per player, repeating:

```
rank, handle, total launches, bots killed, bots lost
1,     sethowar, 856,          1 033 192,   168 700
```

The page also carries a profile image whose CSS class encodes an account status
(`gold-status` seen in the wild) and a link to `/Player/Details/<handle>`, neither of
which the packed string keeps. Worth capturing at parse time if player work is wanted,
because re-scraping 61,517 pages to recover it later would not be reasonable.

Unpacking is a staging model over data already on disk: ~924,728 rows, one per player per
MAZ appearance.

## 2. MAZ relative impact

**The question:** for the zones within 30 miles of Hebron, how much bot activity went into
Hebron itself versus the combined surrounding zones?

Then the shape of it. What does the distribution of that concentration look like across
all MAZ? Is it consistent, or are there distinct regimes — a lone dominant zone versus a
genuinely contested neighbourhood? How heavy is the tail?

Partly a statistics question and partly a visual one, and the statistics should come
first, because the answer decides whether this is a map layer, a chart, or both.

Note the denominator problem before starting: a MAZ is the daily *top ten*, so activity in
surrounding zones is only visible through `fct_zone_events`, which measures bot count
changes rather than launches. Those are different quantities and comparing them naively
would overstate the MAZ.

## 3. MAZ timelapse — **built**

Shipped as the `Timelapse` view mode. Both open questions were settled by building all the
candidates and comparing them on the real map:

- **A MAZ does not flash.** Ten zones a day on a world map reads as nothing.
- **Size and brightness are both a rolling 30-day appearance count** — "chronic hotspot".
  Streak flickers; a decay makes "now" fuzzy for no gain.

See `CLAUDE.md`, "Timelapse is a mode, not another window".

## 4. Highlight MAZ in the existing views — **not needed**

Folded into §3 rather than built separately. A MAZ ring only ever draws in Timelapse, and
the aggregate treatment this section wanted for Week and longer turned out to be the same
rolling window the timelapse already uses. Adding it to the windows as well would put a
second time model in front of the same marks.

## 5. Tournament (Atlantis) map layer

**Reference material, gathered but not yet read in depth:**

- Community history: <https://qonqr.fandom.com/wiki/Atlantis_History>
- Mechanics gist: <https://gist.github.com/AgentConDier/57d687c085c7f7687cf08743fd06a539>
- Live sample of the newest tournament reports:
  `https://api-proxy.auckland-cer.cloud.edu.au/QONQR/Select%20*%20from%20battlestats%20where%20country=%22Atlantis%22%20order%20by%20%60Battle%20Report%20Number%60%20desc%20limit%2010`
  (the mirror; our own copy is `stg_battlestats where is_tournament`)

Read those before designing anything — the shape Atlantis zones take on the in-game map is
the thing that decides what this layer is, and it is not derivable from the report data.

Tournament zones have no coordinates and never will, so they cannot sit in the geographic
projection. They do take a specific shape on the map in-game, which means this is a real
layer with its own geometry, not a filter over the existing dots.

`Region` on a tournament report holds the owning faction rather than a place, which is
probably the organising key for whatever that layer looks like.

## 6. Player and launch dashboard

Weapon launches break down by type and faction — 15 weapons × 4 factions on every report,
already landed and currently unread by any model. Combined with the unpacked player rows
there is enough for a real analytical surface.

Per-report totals are already exported and kept current: `maz_stats.bin.br` carries active
players, launches and bots launched/killed/lost, row-aligned with `maz.bin.br` so `idx`
joins on to names, coordinates and history. Nothing draws them yet. The per-*player*
breakdown still needs §1.

Identify which relationships are statistically meaningful before designing anything. The
temptation with 77 columns is to plot all of them.
