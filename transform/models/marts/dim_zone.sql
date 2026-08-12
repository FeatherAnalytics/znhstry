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
-- region_id alone, which is what the game itself joins on. QONQR's own site reports
-- 1,890 zones in West Pomeranian Voivodeship and 198 in Northwest Territories, and
-- both figures are the region_id count including the zones whose country disagrees.
-- Country totals there come from country_id: Poland is 44,080 either way. So the two
-- fields are read independently, and a region is not a subset of its country.
--
-- 447 zones make that visible. 155 filed under West Pomeranian Voivodeship sit at
-- 162E in the Solomon Islands, and 135 under Northwest Territories are in the DRC.
-- The coordinates and country_id agree with each other, so those zones are certainly
-- not in Poland or Canada -- but the game files them there, and matching the game is
-- what lets a number here be checked against the one a player is looking at.
--
-- The cost is that regions do not sum to their country: Poland's regions total
-- 44,235 against 44,080, and the Solomon Islands' 2,581 against 2,736. Anything
-- presenting regions as a partition of a country has to say so.
left join {{ ref('stg_regions') }}   r on r.region_id  = z.region_id
left join {{ ref('stg_countries') }} c on c.country_id = z.country_id
left join {{ ref('stg_factions') }}  f on f.faction_id = z.control_state
