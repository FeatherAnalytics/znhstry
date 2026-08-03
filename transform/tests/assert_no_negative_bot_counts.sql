-- Bot counts are physically non-negative, so a negative one means the
-- cumulative-sum-of-deltas logic has drifted from the source somewhere.
-- Cheap end-to-end check on the arithmetic the whole project rests on.
select 'fct_global_daily' as model, cast(activity_date as varchar) as key
from {{ ref('fct_global_daily') }}
where legion_bots < 0 or swarm_bots < 0 or faceless_bots < 0

union all

select 'fct_zone_checkpoints', cast(zone_id as varchar)
from {{ ref('fct_zone_checkpoints') }}
where legion_count < 0 or swarm_count < 0 or faceless_count < 0
