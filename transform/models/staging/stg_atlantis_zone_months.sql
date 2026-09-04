-- Grain: one row per tournament zone per tournament month.
select
    "Month"        as tournament_month,
    "Zone"         as zone,
    "ZoneName"     as zone_name,
    "CubesAllowed" as cubes_allowed
from {{ source('raw', 'atlantis_zone_months') }}
