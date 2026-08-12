-- Every zone carries the region its `region_id` names, the way the game reads it.
--
-- QONQR's own site counts regions by `region_id` alone -- 1,890 zones in West
-- Pomeranian Voivodeship, 198 in Northwest Territories -- while counting countries by
-- `country_id`, where Poland is 44,080. Matching that is what lets a number here be
-- checked against the one a player is looking at, and dropping a region label because
-- its country disagrees would put us permanently 155 zones below the game on Poland's
-- best-known region.
--
-- Returns rows if a zone with a `region_id` ever comes back without the label -- which
-- is what a join on both keys does, and what someone reintroduces the moment the 447
-- contradicted zones look like a bug worth fixing. They are not a bug on our side. The
-- game files a zone at 162E in the Solomon Islands under a Polish voivodeship, and this
-- is a mirror of the game.
select
    z.zone_id,
    z.region_id,
    z.country_id,
    z.region_name
from {{ ref('dim_zone') }} z
where z.region_id is not null
  and z.region_name is null
