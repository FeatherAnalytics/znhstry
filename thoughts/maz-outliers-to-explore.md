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
