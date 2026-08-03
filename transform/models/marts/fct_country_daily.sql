-- Grain: one row per country per calendar day, dense within each country's
-- observed span.
--
-- Same cumulative-delta trick as fct_global_daily, partitioned by country.
-- Because a running sum is linear, summing this across countries reproduces
-- fct_global_daily exactly -- which is what the reconciliation test checks.
with daily as (
    select
        country_id,
        activity_date,
        sum(legion_delta)   as legion_delta,
        sum(swarm_delta)    as swarm_delta,
        sum(faceless_delta) as faceless_delta,
        count(*)            as event_count,
        count(*) filter (where is_capture) as capture_count
    from {{ ref('fct_zone_events') }}
    where country_id is not null
    group by 1, 2
),

date_spine as (
    select cast(unnest(generate_series(
        (select min(activity_date) from daily),
        (select max(activity_date) from daily),
        interval 1 day
    )) as date) as activity_date
),

spine as (
    select c.country_id, d.activity_date
    from (select distinct country_id from daily) c
    cross join date_spine d
),

filled as (
    select
        s.country_id,
        s.activity_date,
        coalesce(d.legion_delta,   0) as legion_delta,
        coalesce(d.swarm_delta,    0) as swarm_delta,
        coalesce(d.faceless_delta, 0) as faceless_delta,
        coalesce(d.event_count,    0) as event_count,
        coalesce(d.capture_count,  0) as capture_count
    from spine s
    left join daily d
        on  d.country_id    = s.country_id
        and d.activity_date = s.activity_date
)

select
    f.country_id,
    c.country_name,
    c.country_code,
    f.activity_date,
    sum(f.legion_delta)   over w as legion_bots,
    sum(f.swarm_delta)    over w as swarm_bots,
    sum(f.faceless_delta) over w as faceless_bots,
    sum(f.legion_delta + f.swarm_delta + f.faceless_delta) over w as total_bots,
    f.legion_delta,
    f.swarm_delta,
    f.faceless_delta,
    f.event_count,
    f.capture_count
from filled f
left join {{ ref('stg_countries') }} c on c.country_id = f.country_id
window w as (
    partition by f.country_id
    order by f.activity_date
    rows between unbounded preceding and current row
)
