-- Grain: one row per country. Bounding box, zone count and newest day's bots per faction.
--
-- Longitude bbox uses the shorter of the raw and shifted-by-360 spans, so countries
-- straddling the antimeridian (US/Alaska, Russia, NZ, Fiji) get a tight box instead
-- of one that covers the globe. The shifted box's max_longitude can exceed 180.
with raw_bbox as (
    select
        z.country_id,
        c.country_name,
        c.country_code,
        count(*)           as zone_count,
        min(z.latitude)    as min_latitude,
        max(z.latitude)    as max_latitude,
        min(z.longitude)                                        as raw_min_lon,
        max(z.longitude)                                        as raw_max_lon,
        min(case when z.longitude < 0 then z.longitude + 360
                 else z.longitude end)                          as shifted_min_lon,
        max(case when z.longitude < 0 then z.longitude + 360
                 else z.longitude end)                          as shifted_max_lon
    from {{ ref('dim_zone') }} z
    inner join {{ ref('stg_countries') }} c on c.country_id = z.country_id
    where z.country_id is not null
    group by z.country_id, c.country_name, c.country_code
),
bbox as (
    select
        country_id,
        country_name,
        country_code,
        zone_count,
        min_latitude,
        max_latitude,
        case when (shifted_max_lon - shifted_min_lon) < (raw_max_lon - raw_min_lon)
             then shifted_min_lon else raw_min_lon end as min_longitude,
        case when (shifted_max_lon - shifted_min_lon) < (raw_max_lon - raw_min_lon)
             then shifted_max_lon else raw_max_lon end as max_longitude
    from raw_bbox
)
select
    b.country_id,
    b.country_name,
    b.country_code,
    b.zone_count,
    b.min_latitude,
    b.max_latitude,
    b.min_longitude,
    b.max_longitude,
    coalesce(d.legion_bots, 0)   as legion_bots,
    coalesce(d.swarm_bots, 0)    as swarm_bots,
    coalesce(d.faceless_bots, 0) as faceless_bots,
    coalesce(d.total_bots, 0)    as total_bots,
    d.activity_date              as as_of
from bbox b
left join {{ ref('fct_country_daily') }} d
    on d.country_id = b.country_id and d.is_latest
