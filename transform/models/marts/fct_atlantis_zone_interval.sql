-- Grain: one row per zone and pair of consecutive observations within one
-- tournament month.
with lagged as (
    select
        z.tournament_month,
        z.zone,
        z.observed_at,
        lag(z.observed_at) over (
            partition by z.tournament_month, z.zone
            order by z.observed_at
        ) as previous_observed_at,
        z.swarm_count,
        z.legion_count,
        z.faceless_count,
        lag(z.swarm_count) over (
            partition by z.tournament_month, z.zone order by z.observed_at
        ) as prev_swarm,
        lag(z.legion_count) over (
            partition by z.tournament_month, z.zone order by z.observed_at
        ) as prev_legion,
        lag(z.faceless_count) over (
            partition by z.tournament_month, z.zone order by z.observed_at
        ) as prev_faceless,
        zm.zone_name,
        zm.cubes_allowed
    from {{ ref('stg_atlantis_zones') }} z
    left join {{ ref('stg_atlantis_zone_months') }} zm
        on  zm.tournament_month = z.tournament_month
        and zm.zone             = z.zone
)

select
    tournament_month,
    zone,
    zone_name,
    cubes_allowed,
    observed_at,
    previous_observed_at,
    epoch(observed_at - previous_observed_at) / 60.0 as minutes,
    swarm_count,
    legion_count,
    faceless_count,
    swarm_count    - prev_swarm    as swarm_delta,
    legion_count   - prev_legion   as legion_delta,
    faceless_count - prev_faceless as faceless_delta,
    -- Tie order matches export.py's _leader: holder wins if tied, then
    -- Legion > Swarm > Faceless. A tie has not occurred in the data and
    -- cannot be resolved from it.
    case
        when greatest(legion_count, swarm_count, faceless_count) = 0 then null
        when legion_count = greatest(legion_count, swarm_count, faceless_count) then 'Legion'
        when swarm_count = greatest(legion_count, swarm_count, faceless_count) then 'Swarm'
        else 'Faceless'
    end as holder
from lagged
where previous_observed_at is not null
