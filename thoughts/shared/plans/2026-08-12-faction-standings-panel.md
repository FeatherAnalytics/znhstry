# Per-faction standings for a selection: zones held and bots held

**What this builds:** for whatever is selected — the whole scope, a country, a region, a
picked circle, the viewport, or one zone — how many zones each faction leads and how many
bots each faction has standing there, side by side.

**Most of it already exists.** `StatsPanel` shows per-faction bot counts today, sourced from
the same series the chart draws so the two agree by construction. What is missing is the
zone side: how many zones each faction leads. That number needs no new export data, no new
request, and no new pass over the zones — the map's own bytes already carry it.

**This is a panel, not a page.** A separate page would have to rebuild the selection
machinery — `mapFilter`, `filter`, the area picker, near-me, the tile focus queue — to
answer a question the main page can already scope. The whole value is that the numbers move
with what the reader has selected.

---

## What the two halves are, and why they must stay apart

| | Source | Exact? |
|---|---|---|
| bots per faction | the selection's own series (`scope_daily`, `series/country`, `series/region`, `series/cells`, or one `zone_history` block) | yes, except a circle or the viewport, which aggregate one-degree cells |
| zones per faction | `display.pk`, one byte per zone, faction in the top two bits | **always exact** — counted off the bytes the map is drawing |

Keeping the provenance straight is the whole discipline here. The panel already keeps three
counts apart — `count` (zones in the selection), `held` (zones with bots on the ground) and
`drawn` (zones the window is showing) — and mixing them is how it starts lying. This adds a
fourth family, and it belongs to the `held` side: **the three faction zone counts plus the
empty ones sum to `count`.** That is what makes a share bar honest.

**Say "leads", never "controls".** `pk`'s faction bits come from `_leader` — the faction with
the most bots standing in the zone on that date — not from `control_state`, which keeps
naming whoever captured a zone last long after their last bot is gone. Counting the control
flag reports every zone ever captured as currently held, which is the "1.6M of 1.6M" number
that never moves. The two agree for all but 50 events across 43 zones, and the honest label
costs nothing.

---

## Phase 1 — the worker counts the breakdown it is already walking

`displayWorker.ts` finishes every answer with a sequential pass over `state` to count
`held`. Three more counters in that loop are free, and the reason to put them there rather
than in the panel is measured: the panel's own pass reads `pk` through the slot
indirection, which is a cache miss per zone and was **10.8% of all CPU during playback**.

```ts
// displayWorker.ts, in the pass that already computes `held`
const byFaction = [0, 0, 0, 0];   // 0 empty, 1 legion, 2 swarm, 3 faceless
let held = 0;
for (let i = 0; i < zoneCount; i++) {
  byFaction[state[i] >> 6]++;
  if (state[i] !== 0) held++;
}
```

**`held` keeps its own test rather than becoming `zoneCount - byFaction[0]`.** The two are
equal only while `pk == 0` and `faction == 0` describe the same zones, which holds today —
`_leader` returns uncaptured exactly when the total is zero, and `_magnitude(0)` is 0, so an
empty zone packs to a zero byte — but that is an invariant of the *export's* packing, two
languages away, and trading an explicit test for a dependency on it buys one decrement per
zone. `held` is the number the panel has always shown; it should not change definition to
save nothing.

`StateMessage` gains `byFaction: [number, number, number, number]`. A plain tuple, not a
`Uint32Array`: four numbers structured-clone for nothing, while a typed array is either a
copy or another entry in a transfer list that exists to move megabytes.

**Why the worker and not the page:** the unfiltered case is the common one and the page
deliberately does not walk 2.68M zones for it. Asking the panel to produce a scope-wide
faction breakdown on the main thread reintroduces exactly the pass that was removed.

## Phase 2 — the page counts the selection case in the loop it already runs

With an area selected the worker has never seen the mask, so the page counts. It already
walks the slots for `count`, `held` and `drawn`; the faction breakdown is one more array
write in the same iteration:

```ts
// page.tsx, inside the existing slot loop
byFaction[display.pk[slot] >> 6]++;
count++;
if (display.pk[slot] !== 0) held++;
if (display.visible[slot] !== 0) drawn++;
```

No new loop and no new indirection — `pk[slot]` is already being read on that line.

**The two counting sites do not cover the same zones, and that predates this.** The worker
walks `state`, which the display shards fill for every zone whether or not its tile has
landed; the page's loop is bounded by the slots actually loaded. So the unfiltered breakdown
is world-complete and a selection's is load-bounded. `held` has always behaved this way and
nobody noticed, because one number moving during load reads as loading. Three shares moving
against each other is more legible, so the panel needs `pending` to be honest here — or the
worker's count needs bounding to the same slots, which it cannot see. Prefer the flag.

## Phase 3 — the panel

`Totals` gains a zone-side sibling rather than more fields, so a caller cannot pass bot
counts where zone counts are expected:

```ts
export interface FactionZones {
  legion: number;
  swarm: number;
  faceless: number;
}
```

No `empty` field: the panel already has `count` and `held`, and empty is `count - held`. A
fourth number that is a subtraction of two the panel is already rendering is one more thing
that can disagree with them.

Each faction row then carries two numbers: bots, and zones led. The existing row already
has the colour swatch, the label, the value and a share bar, so this is a second value in a
row that exists.

**The share bar changes meaning and has to be relabelled.** Today it is a faction's share of
the bots. With zones alongside, two different shares are on screen, and a single unlabelled
bar becomes ambiguous. One bar, explicitly of one thing — bots, since that is the quantity
the chart beneath it is plotting — and the zone count as a plain number beside it.

**Suppress the zone breakdown when the panel is reporting change.** In a window the panel
switches to movement: `held` becomes `drawn` and the faction values become deltas. A
per-faction *zone* count is a level, not a delta, and there is no honest delta available —
"which faction gained most zones over the window" is the very thing the map refuses to
colour by, because it makes one visual vocabulary mean two things. So in change mode the
zone column is absent, and `Current` is where it appears.

**Only the bot side is ever approximate.** A circle or the viewport aggregates one-degree
cells, and the chart's subtitle already says "to the nearest degree" when it does. The zone
counts beside it are exact for the same selection, so the qualifier has to sit on the bot
number specifically rather than over the panel — otherwise it disclaims a number that needs
no disclaimer.

## Phase 4 — the total, and the zones nobody holds

Two rows below the three factions, and neither is a rounding-up of the others.

**The total.** Bots across all three factions, and zones across the whole selection. It is
the number every share is a share of, and without it on screen the reader has to add three
figures to know what they are looking at. Its provenance is inherited, not uniform: the bot
total is approximate for a circle or the viewport because it is a sum of approximations,
while the zone total is `count` and exact for every selection.

**The unheld zones, split in two.** A zone holding nothing is a fact worth stating rather
than the gap left over from the factions, and there are two kinds:

| | What it is | How it is counted |
|---|---|---|
| never played | a real place with no bot in fourteen years | `everActive == 0` |
| fought to empty | held something once, holds nothing now | `everActive == 1`, `pk == 0` |

The map already draws these as two shades of grey, so the panel agreeing with it costs
nothing and disagreeing would be a contradiction on one screen.

**The never-played count needs no pass at all.** It cannot change with the date — a zone with
no bot in the whole record is empty in every frame, which is exactly why terrain is built
once when tiles land rather than per date. For the whole scope it is
`meta.scope.zone_count - meta.scope.active_count`, a constant of 1,087,356. For a selection
the page's loop reads `geometry.everActiveBySlot[slot]`, which is slot-keyed like `pk` and so
adds no indirection:

```ts
// page.tsx, in the same loop
if (display.pk[slot] === 0 && geometry.everActiveBySlot[slot] === 0) neverPlayed++;
```

Fought-to-empty is then `count - held - neverPlayed`, and the four categories — three
factions plus unheld — sum to `count` by construction rather than by a second count that
could disagree.

**The worker does not need to know about any of this.** It has `state`, which is idx-keyed,
and no `everActive`. Keeping the split on the page side means the worker's message stays four
numbers, and the unfiltered case gets its never-played figure from the manifest.

## Phase 5 — a country's regions, each on its own

Selecting a country asks two questions at once: how is the country doing, and where inside it
is anything happening. The panel answers the first; a list of per-region rows answers the
second.

**Both halves are already paid for.**

- **Bots per region** come from `series/region.bin.br`, and selecting any single region
  already fetches the whole 3.19 MB shard — it carries every region in the world. So a
  country's regions cost nothing beyond a fetch the reader may already have made.
- **Zones per region** come from one pass over the country's zones, bucketing
  `display.pk[slot] >> 6` by `geometry.region[idx]`. The pass over the selection already
  runs; this is a second array write inside it.

**The country-wins rule is not optional here.** For 447 zones the region they name belongs to
a different country — 155 zones pointing at West Pomeranian Voivodeship sit in the Solomon
Islands. A per-region rollup that trusts `region_id` alone puts those zones under a region on
the other side of the world and inflates a row the reader has no way to question. Bucket only
zones whose `country[idx]` matches the selected country, and drop the rest into an explicit
"region not identified" row rather than silently. `dim_zone` and the export's own region
series already apply this rule, so the panel matching them is what keeps the three agreeing.

**The list has to be ranked and capped, and the cap has to be spoken.** The median country
has 10 regions and the mean 15, but Slovenia has 174, Latvia 118 and Russia 83 — a raw list
is unusable for a third of the world. Rank by bots held, show the top ten, and print what was
left out with its total: a silent truncation reads as "that is all of them", which is the
failure mode the export's own logging rule exists to prevent.

**Regions with nothing in them still belong in the total, not the list.** A country's regions
that hold no bots would be most of the rows for a large quiet country, and they are the answer
to a different question. Their count and their zone total go in the summary line above the
list.

## Phase 6 — the single-zone case

Selecting one zone makes the breakdown degenerate: one faction leads with a zone count of
1, the other two show 0. That reads as a bug rather than as a fact. For a single zone the
panel already has the exact history block, so it should show the three bot counts and drop
the zone column entirely — the identity of the leader is already the dot's colour and the
hover's label.

---

## What this does not need

- **No export change.** Both halves come from payloads the client already holds. Nothing is
  added to `meta.json`, no shard changes, no new tree, and the nightly is untouched.
- **No new request.** The series for every selection is already fetched to draw the chart.
- **No second pass over the zones.** Both counting sites are loops that already run.
- **No new series grain.** A per-faction *zone count over time* would be a new export —
  `series/` carries bots, not zone counts — and it is a different feature. The panel's
  numbers are for the date on screen.
- **No per-region fetch.** The region series is one shard covering every region in the world,
  so a country's regions are already in hand or one fetch away, and that fetch is the same one
  a single region selection makes.
- **No count of never-played zones over time.** It is a constant. Anything treating it as a
  series is describing the crawler's progress rather than the game.

## Concerns

- **The card is now carrying a lot.** Three factions, a total and two unheld categories, each
  with bots and zones, on top of a date, a scope label, a zone denominator and a growth delta.
  The mobile sheet is the binding constraint — the floating card is 268 px against a 390 px
  screen, at which point it stops being an overlay and becomes the page. The order to shed in
  is: the never-played/fought-to-empty split collapses to one unheld row, then the zone column
  goes, then the region list moves behind a disclosure. The three faction bot counts and the
  total are what the chart beneath continues, so they stay.
- **A region list turns one selection into two scopes on one screen.** The panel is about the
  country while the rows are about regions, and the reader has to know which number answers
  which. The rows are subordinate — indented under a summary line that names the country and
  says how many regions are shown out of how many exist.
- **Empty needs a name that is not "uncaptured".** A zone fought down to nothing and a zone
  never played in fourteen years are both empty, and the map already distinguishes them with
  two shades of grey via `ever_active`. The panel should either use that distinction or avoid
  implying it. `count - held` is the number; what it is called is the decision.
- **The three factions plus empty sum to `count` only when nothing is filtered out by the
  window.** In `Current` they do. In a window, `drawn` is a subset of `count` and the
  breakdown is over all of `count`, so a share bar drawn against `drawn` would exceed 1. This
  is the same reason the zone column is suppressed in change mode; it is worth stating twice
  because the arithmetic looks like it should work.
- **Mid-load counts.** Both loops are bounded by the slots actually loaded, so an early
  count describes the zones on the map rather than the world. That is correct and already
  how `held` behaves, but a faction breakdown makes it more visible: the shares will shift
  as tiles land. The existing `pending` flag is the right signal.
- **`paint/` fills `display.pk` before any worker answer.** So a first-frame breakdown is
  available from the tiles alone, which is a feature — but it is the *newest* standings, and
  it must not be shown against a historical date. `useZoneData` already gates `paint/` bytes
  to the newest date with no window open; the panel inherits that and should not second-guess
  it.

## The number to check it against

The whole scope on 2026-08-12, from two independent sources that agree exactly — the
published manifest's own `current` block, and the event stream re-derived from
`zone_history/` in the hydrated warehouse:

| | Bots | Zones led |
|---|---|---|
| Legion | 24,224,517,577 | 625,472 |
| Swarm | 26,048,562,013 | 514,265 |
| Faceless | 27,578,810,929 | 422,126 |
| Emptied | — | 33,861 |
| Never played | — | 1,086,718 |
| **Total** | **77,851,890,519** | **2,682,442** |

Three things fall out of that table, and all three are worth checking on screen rather than
trusting:

- The five zone figures sum to `zone_count` exactly. If they do not, the four categories are
  not a partition and the panel is double-counting or dropping zones.
- The three faction zone counts sum to 1,561,863, which is the manifest's own `held`. So the
  breakdown and the number the panel has always shown agree.
- Never played is `zone_count - active_count` to the zone, which is what makes reading it off
  the manifest rather than counting it correct.

**Faceless leads on bots and trails on zones**, which is the pairing earning its place: 27.6B
bots across 422,126 zones is 65,000 a zone, against Legion's 39,000. Depth against breadth,
and neither number says it alone.

## Open questions

- **Does the zone column belong in the same rows as the bots, or as its own line?** Same
  rows is compact and invites the reader to compare a faction's bots to its zones, which is
  a real question — bots per zone is a garrison-depth measure. Separate lines are clearer at
  the cost of vertical space. UNCONFIRMED, wants looking at.
- **Should bots-per-zone be shown outright?** It falls out of the two numbers, it is the
  only genuinely new insight the pairing creates, and Hebron at 29.6M bots in one zone
  against a region of thousands is the case that makes it interesting.
- **Region and country selections are exact, so should they say so?** Every other panel
  number carries no provenance marker, and adding one only where it is good may imply the
  others are not.
