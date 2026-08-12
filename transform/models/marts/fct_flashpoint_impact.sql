-- Grain: one row per flashpoint per day per group, over the flashpoint's run window.
--
-- What a flashpoint did to the bots around it. Two groups -- the zones that were on the
-- leaderboard during the flashpoint's own days, and every other zone inside the same
-- circle -- so the second one answers the question the first cannot: did the fight pull
-- its neighborhood down with it, or was it contained?
--
-- **`net_delta` is a sum of per-event steps, never a difference between calendar days.**
-- `fct_zone_events.total_delta` is already the step against that zone's own previous
-- observation, computed once in `int_zone_events`, so summing it over any window is the
-- net change across that window and dormant zones carry forward for free. The changelog
-- is sparse by design -- 504,410 zones last changed in 2019 or earlier -- so anything
-- that reads a day with no row as a zero has discarded a third of the map.
--
-- **`zones_moving` is not decoration.** It is how a reader tells "the neighborhood was
-- calm" from "we have no rows". Six of the ten flashpoints produce no on-the-board rows
-- at all: the changelog before late 2018 is a thin stream of first sightings and 2019 is
-- the collection gap, so the battle reports say the fight happened while the event
-- stream has nothing to show for it. `fct_flashpoint.changelog_covered` is the flag that
-- says so; this column is the evidence behind it.
--
-- **This reads `fct_zone_events`, so it is not behind the export's `RECORD_START` cut.**
-- Every other export query goes through a `zone_events` view that drops everything before
-- release, and a mart cannot see that view. It makes no difference to the curated ten -
-- the earliest run window opens in December 2014 - but a flashpoint seeded before
-- 2012-07-30 would carry pre-release testing rows and the 2010 backfill sentinels into its
-- baseline, silently. Seed inside the game's life; there is nothing to visualize outside
-- it.
--
-- Sparse on purpose. A flashpoint-day with no events in a group has no row, and the
-- client densifies -- the same contract as every other series in this project.
select
    z.flashpoint_id,
    e.activity_date,
    z.on_the_board,
    sum(e.total_delta) as net_delta,
    count(distinct e.zone_id) as zones_moving,
    count(*) as events
from {{ ref('fct_flashpoint_zone') }} as z
inner join {{ ref('int_flashpoints') }} as f
    on f.flashpoint_id = z.flashpoint_id
inner join {{ ref('fct_zone_events') }} as e
    on e.zone_id = z.zone_id
    and e.activity_date between f.run_start and f.run_end
group by 1, 2, 3
