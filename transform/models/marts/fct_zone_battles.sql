-- Grain: one row per battle report, at a real zone. 45,675 reports, 11,721 zones.
--
-- ## This is a daily leaderboard, not a record of every fight
--
-- QONQR publishes a fixed number of reports a day, from `Home/MostActiveZones`. The
-- distribution is unambiguous: exactly 10 reports on 3,451 of the 4,598 covered days,
-- and 27-29 on most of the rest. So a zone appearing here does not mean "a battle
-- happened" -- it means **this zone was among the most active in the world that day**.
--
-- That is a far stronger signal than an event in `fct_zone_events`, and it is the
-- reason this mart is worth having: 9.88M events say where something moved, 45,675
-- reports say where the war actually was. Anything built on this must not describe it
-- as "battles that day", which would imply the other ~3,000 active zones were quiet.
--
-- No zone is ever reported twice on the same day - 45,675 reports across 45,675
-- distinct (zone_id, battle_date) pairs - so battle grain and zone-day grain are the
-- same thing here, and a viewer can key on either without aggregating.
--
-- **Mapped battles only.** Two exclusions, and neither is a judgement about the data:
--
--   * Tournament reports (15,837). The Atlantis tournament world is real, heavily
--     fought competition -- see `stg_battlestats` -- but its zones have negative ids,
--     no coordinates and no row in `dim_zone`, so there is nowhere on a map to draw
--     them. They are excluded because this model is geographic, not because they are
--     noise. Anything counting "all battle reports" must read `stg_battlestats`.
--   * Five reports whose zone is not in `dim_zone`. The inner join drops them rather
--     than carrying a battle that cannot be placed.
--
-- Coverage starts 2014-01-01, not 2012 -- battle reports postdate the game's release
-- by eighteen months. Any chart spanning the full record has to say so, or it implies
-- the game's first two years were battle-free.
select
    b.battle_report_number,
    b.zone_id,
    b.battle_date,
    z.zone_name,
    z.country_id,
    z.latitude,
    z.longitude,

    b.legion_starting_bots,
    b.swarm_starting_bots,
    b.faceless_starting_bots,
    b.legion_ending_bots,
    b.swarm_ending_bots,
    b.faceless_ending_bots,

    b.total_active_players,
    b.total_launches,
    b.legion_total_launches,
    b.swarm_total_launches,
    b.faceless_total_launches,
    b.bots_launched,
    b.bots_killed,
    b.bots_lost
from {{ ref('stg_battlestats') }} b
inner join {{ ref('dim_zone') }} z using (zone_id)
where not b.is_tournament
  and b.battle_date is not null
