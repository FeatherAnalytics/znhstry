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

## Phase 4 — the single-zone case

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

## Concerns

- **Four numbers where the reader may want one.** Three factions plus empty, times bots and
  zones, is six figures in a card that already carries a date, a scope label, a zone
  denominator and a growth delta. The mobile sheet is the constraint — the floating card is
  268 px against a 390 px screen. If it does not fit, the zone column is the part that goes,
  because the bot counts are what the chart continues.
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
