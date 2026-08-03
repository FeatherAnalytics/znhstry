-- Grain: one row per calendar day, dense from first event to last.
--
-- Bot counts by faction for the whole map, every day. The running sum over
-- daily deltas is what makes dormant zones free: their last contribution stays
-- in the total forever because nothing subtracts it.
with daily as (
    select
        activity_date,
        sum(legion_delta)   as legion_delta,
        sum(swarm_delta)    as swarm_delta,
        sum(faceless_delta) as faceless_delta,
        count(*)            as event_count,
        count(*) filter (where is_capture) as capture_count
    from {{ ref('fct_zone_events') }}
    group by 1
),

spine as (
    select cast(unnest(generate_series(
        (select min(activity_date) from daily),
        (select max(activity_date) from daily),
        interval 1 day
    )) as date) as activity_date
),

filled as (
    select
        s.activity_date,
        coalesce(d.legion_delta,   0) as legion_delta,
        coalesce(d.swarm_delta,    0) as swarm_delta,
        coalesce(d.faceless_delta, 0) as faceless_delta,
        coalesce(d.event_count,    0) as event_count,
        coalesce(d.capture_count,  0) as capture_count
    from spine s
    left join daily d on d.activity_date = s.activity_date
)

select
    activity_date,
    sum(legion_delta)   over w as legion_bots,
    sum(swarm_delta)    over w as swarm_bots,
    sum(faceless_delta) over w as faceless_bots,
    sum(legion_delta + swarm_delta + faceless_delta) over w as total_bots,
    legion_delta,
    swarm_delta,
    faceless_delta,
    event_count,
    capture_count
from filled
window w as (order by activity_date rows between unbounded preceding and current row)
