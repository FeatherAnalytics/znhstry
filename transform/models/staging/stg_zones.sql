-- Grain: one row per zone. Current state, overwritten upstream on each import.
select
    "ZoneId"            as zone_id,
    "Description"       as zone_name,
    "RegionId"          as region_id,
    "CountryId"         as country_id,
    "ZoneControlState"  as control_state,
    "Latitude"          as latitude,
    "Longitude"         as longitude,
    "LegionCount"       as legion_count,
    "SwarmCount"        as swarm_count,
    "FacelessCount"     as faceless_count,
    "TotalCount"        as total_count,
    "LastUpdateDateUtc" as observed_at,
    "DateCapturedUtc"   as captured_at
from {{ source('raw', 'zones') }}
