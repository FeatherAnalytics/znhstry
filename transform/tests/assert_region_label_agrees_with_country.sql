-- A zone must never be labelled with a region belonging to a different country.
--
-- `zones.CountryId` is authoritative; `RegionId` is not. Where they disagree the
-- coordinates back the country every time, so the region label is dropped rather
-- than printed. Returns rows if a contradictory label ever reappears -- which it
-- would the moment someone simplifies dim_zone's join back to region_id alone.
select
    z.zone_id,
    z.country_id,
    z.country_name,
    z.region_name,
    r.country_id as region_belongs_to
from {{ ref('dim_zone') }} z
join {{ ref('stg_regions') }} r on r.region_name = z.region_name
where z.region_name is not null
  and r.country_id <> z.country_id
  and not exists (
      select 1
      from {{ ref('stg_regions') }} ok
      where ok.region_name = z.region_name
        and ok.country_id = z.country_id
  )
