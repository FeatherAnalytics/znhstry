-- Grain: one row per tournament zone per hourly observation.
--
-- `zone` is the stable position key (`Prime`, `Legion 1`..`Faceless 6`), not the name the
-- site shows that month; stg_atlantis_zone_months carries the name. The hive `year`
-- column is a physical artifact of the layout and is not selected.
select
    "ObservedAtUtc"                              as observed_at,
    "Zone"                                       as zone,
    "SwarmCount"                                 as swarm_count,
    "LegionCount"                                as legion_count,
    "FacelessCount"                              as faceless_count,
    cast(date_trunc('month', "ObservedAtUtc") as date) as tournament_month,
    "ObservedAtUtc" = max("ObservedAtUtc") over (
        partition by date_trunc('month', "ObservedAtUtc")
    )                                            as is_latest
from {{ source('raw', 'atlantis_zones') }}
