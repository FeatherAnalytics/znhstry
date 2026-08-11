-- Exactly one checkpoint row per zone per year boundary.
--
-- Regression guard. The first version of fct_zone_checkpoints compared dates
-- instead of timestamps, which silently dropped every boundary an event
-- landed on -- 19,062 of them. Dropped rows form no group, so counting
-- duplicates could never see that bug: the test has to start from the rows
-- that *should* exist. Every zone observed before a boundary must have a
-- checkpoint at it, so zero rows and duplicates both return here.
with boundaries as (
    select distinct checkpoint_date
    from {{ ref('fct_zone_checkpoints') }}
),

zone_first_seen as (
    select zone_id, min(observed_at) as first_observed_at
    from {{ ref('fct_zone_events') }}
    group by 1
),

expected as (
    select b.checkpoint_date, z.zone_id
    from boundaries b
    join zone_first_seen z
        on z.first_observed_at < cast(b.checkpoint_date as timestamp)
),

found as (
    select checkpoint_date, zone_id, count(*) as rows_found
    from {{ ref('fct_zone_checkpoints') }}
    group by 1, 2
)

select
    e.checkpoint_date,
    e.zone_id,
    coalesce(f.rows_found, 0) as rows_found
from expected e
left join found f
    on  f.checkpoint_date = e.checkpoint_date
    and f.zone_id         = e.zone_id
where coalesce(f.rows_found, 0) <> 1
