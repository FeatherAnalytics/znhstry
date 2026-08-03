-- Grain: one row per zone per observation.
select
    "ZoneId"            as zone_id,
    "LastUpdateDateUtc" as observed_at,
    "DateCapturedUtc"   as captured_at,
    "ZoneControlState"  as control_state,
    "LegionCount"       as legion_count,
    "SwarmCount"        as swarm_count,
    "FacelessCount"     as faceless_count
from {{ source('raw', 'changelog') }}
