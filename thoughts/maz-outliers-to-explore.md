# MAZ outliers worth a chart

Seven subjects, each one an outlier inside a set that is already the outliers — a MAZ row
means the zone was among the ten most active in the world that day. Figures below come
from `data/znhstry_public.duckdb` (`znhstry hydrate`), so the grain is a day and the
faction launch splits are absent; anything needing those reads the raw layer.

Scale to compare against: 45,695 mapped reports over 11,725 zones and 4,600 covered days,
median 6 active players and 555 launches, p99 42 players and 3,066 launches.

## 1. The four reports that are extreme on both axes

Robust score (median + MAD on log10) at or above 3.5 for players *and* launches. Four rows
out of 45,695. Another 129 are extreme on launches alone, and none on players alone.

| Date | Zone | Players | Launches | Bots sent | Killed | Lost |
|---|---|---|---|---|---|---|
| 2017-05-22 | Chermignac, Poitou-Charentes, France | 201 | 17,885 | 21,351,750 | 56,184,385 | 71,169,697 |
| 2017-05-15 | Breda, North Brabant, Netherlands | 153 | 11,649 | 14,283,450 | 17,244,757 | 26,696,802 |
| 2015-01-16 | Williamsport, Pennsylvania | 132 | 9,821 | 12,091,950 | 15,553,757 | 22,899,077 |
| 2017-05-22 | South Whittier, California | 149 | 7,721 | 10,328,450 | 5,703,928 | 10,250,932 |

201 active players is the record. Two of the four fall on the same date.

**The story to draw:** Chermignac's arc. It holds the largest battle in the record, has been
Swarm-held every year since, and has grown 429M → 546M bots to become the world's third
largest standing garrison. The biggest fight became one of the biggest fortresses.

## 2. 2017-05-22, the biggest day on record

37,097 launches and 628 active players across its ten reports, 45.3M bots sent. Twenty
percent clear of the runner-up (2014-01-16, 30,786). It carries Chermignac at #1 and South
Whittier at #4, plus Kampung Jawa (Malaysia, 84 players) and Knoxville (67).

Context worth putting beside it: the record's extremes are historical. 167 of the top 200
reports by launches fall in 2014–2017, and only 33 across the nine years since.

## 3. Hebron, Texas — the frequency outlier

1,287 appearances of 4,600 covered days. `idx` 1457379, `ZoneId` 1543200.

Not a twelve-year dynasty: 2 appearances in 2014, 4 in 2015, nothing until 177 in 2021,
then 171, 115, **320 of 366 in 2024**, 300 in 2025, 198 so far in 2026. Peak 28 active
players, and only 18 in its heaviest year — so it earns the leaderboard by changing every
single day rather than by being fought over. Its own event stream agrees: 365 events in
2024, and a garrison climbing 5.5M (2018) → 29.6M (2026).

**The story to draw:** the most frequent entrant on a "most active" leaderboard is not a
battle at all. Chart appearances per year against peak players to make the point.

## 4–6. The three tightest region-day clusters

Days where one region holds 5 or 6 of the world's ten most active zones: 21 in the record,
20 at five zones and one at six. Median diameter 189 km, range 10.9 to 996 km — so a region
repeating is usually *not* one local fight. The tight end is.

**2019-07-16, England — 10.9 km diameter**, 5.8 km mean pair, 2.0 km closest. The
Dartford–Gravesend corridor in Kent.

| Zone | Players | Launches |
|---|---|---|
| Dartford | 10 | 5,953 |
| Sutton at Hone | 8 | 720 |
| Stonewood | 2 | 695 |
| Gravesend | 4 | 581 |
| Darenth | 7 | 528 |

Dartford is also a one-day spike: 5,953 launches and never on the leaderboard again.

**2019-06-11, England — 19.4 km diameter**, 10.1 km mean, 1.4 km closest. The only six-zone
region-day in the record: Blean, Tankerton, Whitstable, Bekesbourne, Aylesham, Bridge — a
ring around Canterbury. Two to three players each, 342–409 launches. A neighborhood war,
not a siege.

**2022-03-27, Michigan — 25.8 km diameter**, 16.3 km mean, 1.3 km closest. All around
Marquette in the Upper Peninsula: Brookton Corners (3,630 launches), Trowbridge Park
(2,232), Plains (1,850), Eagle Mills (1,120), K. I. Sawyer Air Force Base (1,035). One or
two players per zone, so a handful of people took five of the world's ten slots.

## 7. South Australia, 2024-09-12 / 13 / 14

The same region holds five of the world's ten most active zones on three consecutive days,
and the group tightens each day: **44.3 → 34.0 → 27.5 km** diameter, mean pair 24.8 → 24.8
→ 15.7 km. The only place in the record where a five-zone region-day repeats at all, let
alone converges.

**The story to draw:** a front closing over three days. This is the case that argues for
tracking a fight across dates rather than one day at a time.

### Hebron with its neighborhood flagged

Hebron on its own is a flat line, so the chart that works is Hebron as backdrop with
everything else within `NEIGHBORHOOD_KM` drawn on top. On **1,135 of its 1,287 days (88.2%)
nothing else within 30 miles is on the board at all**; 147 days carry one neighbor, four
carry two, and one carries three.

| Neighbor | Shared days | Distance | Launches | Peak players |
|---|---|---|---|---|
| Reinhardt | 60 | 26.8 km | 37,682 | 16 |
| Dallas | 13 | 27.6 km | 19,154 | 31 |
| Rawlins | 12 | 24.1 km | 5,975 | 6 |
| Camey | 8 | 6.4 km | 4,115 | 9 |
| Ledbetter Hills | 7 | 37.6 km | 3,209 | 5 |

**And the flag pays for itself immediately.** On 2024-03-25, Dallas — 27.6 km away — logged
12,313 launches from 31 players, the **sixth largest report in the entire record**, while
Hebron logged 444. Hebron's own series says nothing happened that day.

The busiest neighborhood day is 2023-12-22, the only three-neighbor day: Pleasant Run
(1,472 launches, 47.4 km), Grand Prairie (1,020, 33.6 km) and Shamrock (480, 47.6 km)
against Hebron's 814. That is the same day as the 55.9 km Texas region-day cluster, reached
from the other direction.

## 8. Campaigns: the same fight tracked as it moves

A region-day is a snapshot, and every one of the clusters above turns out to be the peak of
something longer. Linking reports in space *and* time finds the whole thing: two reports
belong to the same campaign when they are within `NEIGHBORHOOD_KM` (48.28 km) of each other
and no more than three days apart, and a campaign is a connected component under that rule.
Single linkage, so a fight can walk across a county without ever breaking.

Over the 45,695 mapped reports that gives 13,325 components: 6,954 are a lone report and
2,882 involve two or more zones.

**The Adelaide war is the find.** The three South Australia days are the middle of a
four-month campaign: 232 reports over 70 zones, 119 active days in a 124-day span,
184,447 launches. It opens 2024-08-20 with nine straight days on Athelstone alone, spreads
into the Adelaide Hills, and rolls through Belair, Blackwood, Kyeema, Paris Creek, Willunga
and Port Willunga, the front moving 0 to 30 km a day. The 09-12/13/14 cluster is simply
where it was tightest.

**Both Kent days are also mid-campaign.** 2019-06-11's Canterbury ring is the fourth day of
a run down the Thames estuary: Shell Haven 3,455 launches on 06-07, **7,216 on 06-08**,
2,167 on 06-09 alongside Newington, Eastchurch and Billericay, then a 39.3 km jump into
Canterbury. Shell Haven's second day is larger than Dartford's peak. And 2019-07-16's
Dartford burst follows South West London on 07-14, 35.4 km west.

Real local campaigns, span under 60 days, ranked by zones drawn in:

| Dates | Days | Zones | Launches | Where |
|---|---|---|---|---|
| 2024-01-03 → 02-28 | 57 | 42 | 29,528 | Île-de-France, France |
| 2021-12-17 → 2022-01-19 | 34 | 30 | 24,585 | Colorado |
| 2026-05-18 → 07-04 | 48 | 30 | 28,017 | Kanton Bern, Switzerland |
| 2023-04-06 → 05-14 | 39 | 29 | 33,969 | Moscow |
| 2014-02-14 → 03-23 | 38 | 25 | 86,448 | Washington |
| 2014-01-26 → 03-06 | 40 | 21 | 92,535 | Michigan |

**Single linkage chains through a persistent zone, and that has to be handled before this
is a statistic.** Hebron appears on more than a quarter of all days, so anything within
48 km of it joins one component that runs 451 reports across 363 days — a year is not a
campaign. Either exclude zones above an appearance threshold, or require a component to
break when no *new* zone joins it for N days. The span-ranked list is unusable until then;
the under-60-day list is not affected.

## 9. What a flashpoint does to the bots around it

The changelog answers this directly. `zone_day.delta` is a zone's step at each event day,
so the net change over any window is the sum of those steps for every zone inside the
circle — and the zones that were *not* on the leaderboard can be totalled separately from
the ones that were.

Method: take every zone within `NEIGHBORHOOD_KM` of the anchor, split it by whether it
appeared in MAZ during the flashpoint's own days, and sum `delta` over the 28 days before,
the flashpoint window itself, and the 28 days after. Per-day rates below, since a one-day
window against a 28-day baseline is not a fair comparison raw.

**Marquette, 2022-03-27** — the clearest case in the record.

| | Zones | Net −28d | Net window (1 day) | Net +28d |
|---|---|---|---|---|
| on the board | 5 | −1,093,771 | **−27,813,744** | −4,721,259 |
| neighbors | 86 | −6,269,248 | −5,815,281 | −6,666,315 |

The five reported zones lost 27.8M bots in a single day against a drift of 39k/day over the
preceding month — **712 times the baseline rate**. And the answer to the question about
non-MAZ zones is yes: the 86 neighbors were shedding 224k/day before and lost 5.8M on the
day itself, **26 times their own baseline**. The fight pulled the whole neighborhood down
with it, and the month after stayed at the elevated rate.

**Adelaide, 2024-09-12 to 14** — a sign flip rather than an acceleration. The nine reported
zones ran +6k/day before and −739k/day across the three days. The 184 neighbors went from
**+20k/day to −30k/day**, and stayed negative for the following month (−917,752). A growing
neighborhood turned into a shrinking one.

**Hebron's neighborhood, 2023-12-22** — same flip, larger numbers. On the board: +190k/day
before, −4.4M on the day. Neighbors: **+446k/day before, −3.78M on the day**, then back to
+242k/day after. A one-day hole in an otherwise growing area.

**Dallas, 2024-03-25 — and this is the interesting negative.** The sixth largest report in
the record, 12,313 launches and 12.5M bots sent, and the neighborhood barely notices: the
two reported zones net −73,890 and the 210 neighbors are *up* 103,330 on the day, against a
+161k/day baseline. Everything launched was absorbed. A huge fight with no territorial
consequence, which is exactly the case that shows launches are not impact.

**The changelog cannot answer this for anything before 2020.** For Chermignac, Breda,
Williamsport, South Whittier and both Kent days, the zones that were fighting have **zero
events** in the surrounding 56 days — the changelog before late 2018 is a thin stream of
first sightings, and 2019 is the collection gap. The battle reports say the fight happened;
the event stream has no rows for it. Do not read those zeros as quiet. Anything in this
section is a 2020-onward statement.

## 10. Outliers the leaderboard never reported

Everything above starts from MAZ, and MAZ is only the world's top ten a day. A huge fight
somewhere that did not crack the global ten is invisible to it. The changelog is not — so
score areas against their own history and the leaderboard stops being the gatekeeper.

Method: aggregate `zone_day` to one-degree cells, take **churn** as `sum(abs(delta))`
rather than net (a day where one faction strips 5M bots off another nets near zero and is
the most violent thing that ever happened there), then score each cell-day against that
cell's own median and MAD. 2020 onward only, since a record day before that is a crawler
artifact.

**Two floors are needed or the ranking is noise.** A cell has to have at least 200 active
days for a MAD to mean anything, and a typical churn of at least ~5,000 or the metric just
finds near-dead cells: a cell whose normal day is 5 bots scores z = 27,777 the first time
anything happens in it.

The method validates itself — **Marquette 2022-03-27 comes back second** without any
reference to MAZ, which is how we know the score is finding real events. What it puts
first is much bigger, and MAZ logged one report for it.

### 2023-05-04, the Allgäu — the largest single-area day in the record

Cell 47°N 10°E, Bavaria running into Tyrol. **133,746,135 bots of churn against a typical
day of 11,675, and it is almost entirely one-directional: 594 of the cell's 603 zones lost
bots, 133,740,938 gone, 5,197 gained.**

| Zone | Delta | Left standing | Holder after |
|---|---|---|---|
| Kempten (Allgäu), Bavaria | −4,475,827 | 140 | faceless |
| Lenzfried, Bavaria | −4,056,954 | 0 | uncaptured |
| Gaicht, Tyrol, Austria | −3,505,563 | 0 | uncaptured |
| Bremberg, Bavaria | −3,089,275 | 360 | swarm |
| Lauben, Bavaria | −3,042,090 | 0 | uncaptured |

**This is not a battle.** In a fight the bots move: one side's losses are somewhere else's
gains. Here 594 zones drop at once and nothing in the cell picks them up, with many falling
to zero and reverting to uncaptured. That is a withdrawal or a removal — a garrison network
leaving the map rather than losing it. A player quitting, an account purge and a
coordinated retreat all look like this, and the changelog cannot tell them apart.

**MAZ logged one report for that cell that day**, which is the point: the leaderboard ranks
by reported activity in a zone, and 594 zones each shedding a couple of hundred thousand
bots is not ten zones being fought over.

### The rest of the top of the list

| Date | Cell | Churn | Zones | MAZ | Note |
|---|---|---|---|---|---|
| 2020-06-22 | 37°N 78°W, Virginia | 78.0M | 561 | 0 | second-largest, entirely unreported |
| 2020-03-26 | 42°N 95°W, Iowa | 62.3M | 8 | 0 | net **+62.3M** — a mass arrival, not a collapse |
| 2020-09-13 | 38°N 93°W, Missouri | 51.2M | 6 | 0 | 51M across six zones |
| 2021-09-13 | 25°N 81°W, Florida | 31.6M | 155 | 0 | |
| 2022-03-27 | 46°N 88°W, Marquette | 33.2M | 13 | 5 | the one MAZ did catch |

The Iowa day is worth its own look: a **gain** of 62.3M concentrated in eight zones is the
opposite shape from everything else here, and it is the closest thing in the data to
watching someone arrive.

## 11. Baselines, and what the distributions say about the game's history

### The MAZ entry bar fell, then stopped falling

The floor is the tenth-place zone on a given day — what it took to make the list at all.

| Year | Median launches | Avg daily floor | Median players | Mode players | Player SD |
|---|---|---|---|---|---|
| 2014 | 1,270 | 925 | 19 | 16 | 12.0 |
| 2015 | 1,052 | 759 | 16 | 14 | 11.0 |
| 2016 | 810 | 596 | 11 | 8 | 7.9 |
| 2017 | 676 | 489 | 10 | 7 | 10.5 |
| 2018 | 495 | 370 | 7 | 5 | 6.5 |
| 2019 | 409 | 306 | 5 | 4 | 4.7 |
| 2020 | 409 | 310 | 5 | 2 | 4.2 |
| 2021 | 396 | 300 | 4 | 2 | 3.2 |
| 2022 | 528 | 366 | 5 | 3 | 3.4 |
| 2023 | 450 | 325 | 4 | 2 | 3.4 |
| 2024 | 418 | 308 | 3 | 2 | 2.8 |
| 2025 | 436 | 304 | 3 | 2 | 2.8 |
| 2026 | 424 | 303 | 3 | 2 | 2.7 |

**It is piecewise, and the knee is 2019.** The floor falls steadily 925 → 306 across
2014–2019 — a third of what it was — and then does not move again: every year since sits
between 300 and 366, with 2022 the only bump. So the game shrank for five years and has
been level for seven.

**The player distribution compressed as well as fell**, which is the more interesting half.
Median active players went 19 → 3 and the mode 16 → 2, but the standard deviation went
12.0 → 2.7. The early game had a spread of crowd sizes; the late game is two players almost
every time, with rare exceptions. Chermignac's 201 in 2017 is the all-time peak and 2024's
maximum is 31.

A single 2016 report carries `min_launches = 1`, which is worth a look before it is quoted
anywhere.

### The changelog's own records are mostly artifacts, and there is a clean test for it

`net == churn` on a day means **no zone anywhere lost a single bot**. That does not happen
in a game being played, and it is a sharper artifact detector than anything in the data
dictionary:

| Year | Days with no losses anywhere | Largest such day |
|---|---|---|
| 2013 | 28 | +2,872,733 |
| 2014 | 165 | +10,446,486 |
| 2015 | 321 | +13,213,878 |
| 2016 | **366 of 366** | +32,128,682 |
| 2017 | **365 of 365** | +161,821,059 |
| 2018 | 277 | +2,835,768,704 |
| 2019 onward | **0** | — |

Two consecutive years in which nothing anywhere ever went down. That is a crawler
enumerating zones, not a war. So **every increase record in the changelog before 2019 is
collection**, including the headline ones: the largest single day in the whole table is
2018-10-04 at +2,835,768,704 across 3,114 zones, and the largest week is 2018-09-24 at
+10,030,684,907 — both with churn exactly equal to net.

### The real extremes, 2019 onward

| | Date | Net | Churn | Zones moving |
|---|---|---|---|---|
| largest increase | 2020-10-25 | +553,766,655 | 642,627,063 | 33,303 |
| largest decrease | 2023-05-04 | −147,632,940 | 171,430,028 | 4,139 |
| largest churn | 2020-03-16 | +322,652,886 | **1,631,989,632** | 4,898 |

**2020-03-16 is the most violent day in the record**: 1.63 billion bots changed hands with
an ordinary number of zones involved, so it is depth rather than breadth. And 2020-10-25's
33,303 zones against a median of 3,836 is broad enough to deserve the same suspicion as the
2018 days, even though real losses did occur.

**The Allgäu day is 90.6% of the world's largest decrease.** 2023-05-04's global −147.6M
includes −133.7M from the single cell at 47°N 10°E. One neighborhood in Bavaria accounts
for nine tenths of the biggest down-day the game has ever had.

A typical day, for reference: the median day moves 2,138–3,836 zones depending on the year,
with a median churn around 30–54M since 2020.

### Still open

- **Atlantis needs the raw layer.** `fct_zone_battles` excludes the 15,837 tournament
  reports because their zones have negative ids and no coordinates, so the hydrated
  warehouse cannot see them. `stg_battlestats` is where they live, and it is behind R2.
- **Metropolitan areas would be a new source.** `urbanstack`'s raw layer is ACS only, so
  there is no CBSA geometry to join against — and it would be US-only, while the record's
  densest cells include Bavaria, Kent and Moscow. A per-cell zone-density measure is
  already available here and answers most of the same questions without a new dependency.
- **Region-level baselines** are the natural next cut: the same year table, grouped by
  `region_id` with the country-wins rule applied, to see whether the 2019 knee is global or
  whether some regions kept their crowds.

## Drawing notes

- `Description` is not unique, so key on `ZoneId` and label with the name.
- Region labels are safe here only because `zone.region` is already null where the region
  contradicts the zone's country.
- Ranking clusters by spread alone promotes tight pairs over a genuine six-zone group; sort
  by count, then by spread within a count.
- Never rank reports by launches alone — Budapest 2024-12-15 is 20,929 launches from two
  players, and it is a different phenomenon from Chermignac.
- **`players` counts faction-player pairs, not people.** Someone who launched for two
  factions in the same zone on the same day is counted under each, so Chermignac's 201 is
  an upper bound on how many humans were there — report 131137 says 4 and lists 3 handles.
  Label it "active players" and let the record claim stand as a claim about that measure,
  not about a crowd. It is also not the 2019 faction shortfall, which runs the other way.

## Reproducing this

Everything above runs against `data/znhstry_public.duckdb`:

```bash
cd pipeline && uv run python -m znhstry hydrate   # ~1,480 requests, cached under data/public
duckdb data/znhstry_public.duckdb
```

Haversine is inline rather than an extension so these paste straight into the CLI, and
48.28032 km is `config.NEIGHBORHOOD_KM` — the same circle the map frames, so the statistic
and the picture describe one circle. Every pairwise query takes `b.idx > a.idx`: the matrix
is symmetric with a zero diagonal and counting either would drag the mean toward zero.

**A distance in kilometres between two zone rows.** Latitude alone is a safe prefilter,
because a degree of latitude is never shorter than 110.57 km, so a window wider than the
radius in degrees cannot clip a pair the haversine would keep. Longitude needs no bound
once a date or day window has already narrowed the candidates.

```sql
6371.0088 * 2 * asin(sqrt(least(1.0,
    pow(sin(radians(b.latitude - a.latitude) / 2), 2)
    + cos(radians(a.latitude)) * cos(radians(b.latitude))
      * pow(sin(radians(b.longitude - a.longitude) / 2), 2))))
-- prefilter: abs(b.latitude - a.latitude) <= 48.28032 / 110.574 * 1.05
```

**Region-days holding 5 or 6 of the world's ten, and how tight they are** (§4–6). Group on
`region_id` *and* `country_id`; `zone.region` is already null where the two disagree, so a
corrupt RegionId cannot invent a group.

```sql
with region_day as (
    select m.activity_date, z.country_id, z.region_id, z.region, count(*) as n
    from maz m join zone z on z.idx = m.idx
    where z.region_id is not null
    group by 1, 2, 3, 4 having count(*) between 5 and 6
), members as (
    select r.*, z.idx, z.name, z.latitude, z.longitude, m.launches
    from region_day r
    join zone z on z.region_id = r.region_id and z.country_id = r.country_id
    join maz m on m.idx = z.idx and m.activity_date = r.activity_date
)
select a.activity_date, a.region, a.n,
       round(max(<haversine>), 1) as diameter_km,
       round(avg(<haversine>), 1) as mean_pair_km
from members a join members b
  on b.activity_date = a.activity_date and b.region_id = a.region_id
 and b.country_id = a.country_id and b.idx > a.idx
group by 1, 2, 3 order by diameter_km;
```

**Neighborhood flags for a persistent zone** (§3): join `maz` to itself on the date, keep
rows within the radius of the anchor, and count them per day. Hebron is `idx` 1457379.

**Campaigns** (§8) are a connected component over pairs of reports within the radius *and*
within three days. The pair list is SQL; the components are a union-find over it, since
DuckDB has no graph primitive:

```sql
select a.rid, b.rid from report a join report b
  on b.activity_date between a.activity_date and a.activity_date + 3
 and b.rid > a.rid and abs(b.latitude - a.latitude) <= 48.28032 / 110.574 * 1.05
where <haversine> <= 48.28032
```

Remember the chaining guard from §8 before quoting a span.

**Flashpoint impact** (§9) sums `zone_day.delta` over three windows for every zone in the
circle, split by whether the zone was on the board during the flashpoint's own days:

```sql
sum(delta) filter (where activity_date between cast(? as date) - 28 and cast(? as date) - 1),
sum(delta) filter (where activity_date between ? and ?),
sum(delta) filter (where activity_date between cast(? as date) + 1 and cast(? as date) + 28)
```

Always report per-day rates, and always print how many zones actually *moved* in the
window — that count is what exposes the pre-2020 gap instead of letting a zero read as calm.
