-- Three zones exist in `changelog` and not in `zones`, and must stay that way.
--
-- 2836390, 2836391 and 2836392 have events but no row in the zones table, so
-- fct_zone_events joins dim_zone on the left and they arrive with a null
-- country_id. That is deliberate: they count toward fct_global_daily and not
-- toward fct_country_daily, which is why the two do not reconcile exactly and
-- why the difference is a documented 722,697 Swarm bots rather than a bug.
--
-- The failure this guards is the obvious "fix" -- making that join inner, which
-- looks like tidying up nulls and instead drops 722,697 bots out of the global
-- series without failing anything. Returns a row if an orphan has gone missing
-- or has acquired a country.
with orphans as (
    select * from (values (2836390), (2836391), (2836392)) as t (zone_id)
),

found as (
    select
        zone_id,
        count(*)           as rows_found,
        count(country_id)  as rows_with_country
    from {{ ref('fct_zone_events') }}
    where zone_id in (2836390, 2836391, 2836392)
    group by 1
)

select
    o.zone_id,
    coalesce(f.rows_found, 0)        as rows_found,
    coalesce(f.rows_with_country, 0) as rows_with_country
from orphans o
left join found f on f.zone_id = o.zone_id
where coalesce(f.rows_found, 0) = 0
   or coalesce(f.rows_with_country, 0) > 0
