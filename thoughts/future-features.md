# Future features

Ideas with enough substance to be worth keeping, none of them started. Nothing here is a
commitment or a plan — it is a place to put things so they stop occupying a conversation.

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

## 3. MAZ timelapse

Flash MAZ on the map over time. Two open questions, and the second should be settled by
the data rather than by preference:

- Does a MAZ flash as a point event, or persist and decay?
- What drives its size — velocity, current streak, or a rolling N-day appearance count?

Three candidate encodings, and they say different things: velocity is "this is escalating
now", streak is "this has been contested for a while", rolling count is "this is a
chronic hotspot". Pick with the distribution work from §2 in hand.

## 4. Highlight MAZ in the existing views

Smaller and more immediate than the timelapse.

- On the Day view, mark the zones that were MAZ that day.
- On Week and longer, some aggregate treatment — count of appearances in the window is the
  obvious candidate, but see §3.

Constraint from the viewer's own rules: whatever this looks like, **picking must apply the
same tests as drawing**, or a hover confidently describes something the reader cannot see.

## 5. Tournament map layer

Tournament zones have no coordinates and never will, so they cannot sit in the geographic
projection. They do take a specific shape on the map in-game, which means this is a real
layer with its own geometry, not a filter over the existing dots.

`Region` on a tournament report holds the owning faction rather than a place, which is
probably the organising key for whatever that layer looks like.

## 6. Player and launch dashboard

Weapon launches break down by type and faction — 15 weapons × 4 factions on every report,
already landed and currently unread by any model. Combined with the unpacked player rows
there is enough for a real analytical surface.

Identify which relationships are statistically meaningful before designing anything. The
temptation with 77 columns is to plot all of them.
