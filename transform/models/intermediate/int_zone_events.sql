-- Grain: one row per zone per observation.
--
-- Turns absolute counts into per-event deltas. This is the pivot the whole
-- project turns on: every downstream aggregate is a cumulative sum of these
-- deltas, which carries dormant zones forward for free. A zone that last
-- changed in 2013 keeps contributing its final value to every later total
-- because nothing ever subtracts it -- no forward-fill, no zone x day grid.
--
-- lag(..., 1, 0) defaults the first observation to zero, which is correct:
-- the pre-2012 sentinel baseline is empty for every zone except the 29 that
-- the extractor pulls explicitly, and those carry their own first row here.
select
    zone_id,
    observed_at,
    captured_at,
    control_state,
    legion_count,
    swarm_count,
    faceless_count,
    legion_count + swarm_count + faceless_count as total_count,

    legion_count   - lag(legion_count,   1, 0) over w as legion_delta,
    swarm_count    - lag(swarm_count,    1, 0) over w as swarm_delta,
    faceless_count - lag(faceless_count, 1, 0) over w as faceless_delta,

    lag(control_state) over w as prev_control_state,
    row_number() over w = 1   as is_first_observation
from {{ ref('stg_changelog') }}
window w as (partition by zone_id order by observed_at)
