-- Grain: one row per zone per year boundary the zone existed through.
--
-- The map's answer to the dormancy problem. 32% of ever-active zones last
-- changed in 2019 or earlier, so a viewer that loads only recent events would
-- render them as empty. A checkpoint is a dense snapshot: every zone's state
-- at midnight on 1 January, dormant ones included. The client loads one
-- checkpoint plus that year's events and can scrub anywhere inside the year
-- without touching the other thirteen.
--
-- Built as a range join rather than a per-boundary window: each event is the
-- prevailing state for every boundary between it and the next event.
with events as (
    select
        zone_id,
        observed_at,
        control_state,
        legion_count,
        swarm_count,
        faceless_count,
        total_count,
        lead(observed_at) over (partition by zone_id order by observed_at) as next_observed_at
    from {{ ref('fct_zone_events') }}
),

boundaries as (
    select cast(unnest(generate_series(
        date '2013-01-01',
        date '{{ var("checkpoint_end_year", 2027) }}-01-01',
        interval 1 year
    )) as date) as checkpoint_date
)

select
    b.checkpoint_date,
    e.zone_id,
    e.control_state,
    e.legion_count,
    e.swarm_count,
    e.faceless_count,
    e.total_count
from events e
join boundaries b
    -- Compared as timestamps, not dates. Truncating to a date drops any
    -- boundary an event lands on: the preceding event fails `next > B` and
    -- the event itself fails `B > observed`, so nothing matches. Half-open
    -- on the left and closed on the right gives exactly one row per boundary.
    on  e.observed_at < cast(b.checkpoint_date as timestamp)
    and (e.next_observed_at is null
         or e.next_observed_at >= cast(b.checkpoint_date as timestamp))
