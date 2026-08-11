-- Grain: one row per zone per observation.
--
-- The event spine for everything downstream. Geography is denormalised on so
-- that regional and national rollups don't have to re-join dim_zone.
select
    e.zone_id,
    e.observed_at,
    cast(e.observed_at as date) as activity_date,
    z.region_id,
    z.country_id,

    e.control_state,
    e.prev_control_state,
    -- A capture is any change of holder. The first observation counts as one
    -- only if the zone did not start uncaptured.
    --
    -- Before October 2018 this is not a gameplay fact. The changelog up to then
    -- is a thin stream of first sightings -- 100% of 2014's battle reports land
    -- on zones with no changelog state at all -- so a zone's first row usually
    -- records the crawler reaching it while already held, not anyone taking it.
    -- Over 2017-04-01 to 2019-12-31 there are 790 conversions actually witnessed
    -- against 817,344 zones whose first row of any kind falls in the window, and
    -- none of the 790 predate October 2018. Anything reading this over the early
    -- record says "first seen holding bots", never "captured".
    coalesce(e.control_state, 0) is distinct from coalesce(e.prev_control_state, 0)
        as is_capture,

    e.legion_count,
    e.swarm_count,
    e.faceless_count,
    e.total_count,

    e.legion_delta,
    e.swarm_delta,
    e.faceless_delta,
    e.legion_delta + e.swarm_delta + e.faceless_delta as total_delta,

    e.is_first_observation
from {{ ref('int_zone_events') }} e
left join {{ ref('dim_zone') }} z on z.zone_id = e.zone_id
