-- Grain: one row per country. Bounding box from dim_zone for radius candidate checks.
select
    z.country_id,
    c.country_name,
    c.country_code,
    count(*)           as zone_count,
    min(z.latitude)    as min_latitude,
    max(z.latitude)    as max_latitude,
    min(z.longitude)   as min_longitude,
    max(z.longitude)   as max_longitude
from {{ ref('dim_zone') }} z
inner join {{ ref('stg_countries') }} c on c.country_id = z.country_id
where z.country_id is not null
group by z.country_id, c.country_name, c.country_code
