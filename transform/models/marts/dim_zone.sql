-- Grain: one row per zone.
--
-- zone_name is NOT unique -- many zones share a name. zone_id is the only key.
select
    z.zone_id,
    z.zone_name,
    z.latitude,
    z.longitude,
    z.region_id,
    r.region_name,
    z.country_id,
    c.country_name,
    c.country_code,
    z.control_state    as current_control_state,
    f.faction_name     as current_holder,
    z.legion_count     as current_legion_count,
    z.swarm_count      as current_swarm_count,
    z.faceless_count   as current_faceless_count,
    z.total_count      as current_total_count,
    z.observed_at      as last_observed_at,
    z.captured_at      as last_captured_at
from {{ ref('stg_zones') }} z
-- Both keys, not just region_id. A zone's country_id is authoritative and its
-- region_id is not: for 447 zones the region's own country contradicts the zone's,
-- and coordinates settle it in the country's favour every time -- 155 zones filed
-- under West Pomeranian Voivodeship sit at 162E in the Solomon Islands. Joining on
-- region_id alone labels those "Solomon Islands / West Pomeranian Voivodeship".
-- Matching on both leaves region_name null instead, which is the honest answer: we
-- know the country and we do not know the region.
left join {{ ref('stg_regions') }}   r on r.region_id  = z.region_id
                                      and r.country_id = z.country_id
left join {{ ref('stg_countries') }} c on c.country_id = z.country_id
left join {{ ref('stg_factions') }}  f on f.faction_id = z.control_state
