-- A zone must never be labeled with a region belonging to a different country.
--
-- `zones.CountryId` is authoritative; `RegionId` is not. Where they disagree the
-- coordinates back the country every time, so the region label is dropped rather
-- than printed. Returns rows if a contradictory label ever reappears -- which it
-- would the moment someone simplifies dim_zone's join back to region_id alone.
--
-- Joined on region_id, because region names collide across countries: zone 27425
-- points at region 3868, `Islands` under South Georgia, while sitting in Norfolk
-- Island, which has an `Islands` region of its own. Matching the label by name
-- finds Norfolk's row and calls the contradiction resolved.
select
    z.zone_id,
    z.country_id,
    z.country_name,
    z.region_id,
    z.region_name,
    r.country_id as region_belongs_to
from {{ ref('dim_zone') }} z
join {{ ref('stg_regions') }} r on r.region_id = z.region_id
where z.region_name is not null
  and r.country_id <> z.country_id
