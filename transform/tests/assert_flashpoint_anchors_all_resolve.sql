-- Every seeded flashpoint reaches the manifest, with a real place behind it.
--
-- `stg_flashpoints` inner-joins the seed to `dim_zone`, so a mistyped `anchor_zone_id`
-- does not fail -- it silently drops the flashpoint, and a picker with nine entries where
-- ten were seeded looks exactly like a picker with nine entries. A null coordinate is the
-- same class of fault one step later: the circle comes back empty, the impact chart is
-- flat, and nothing anywhere says the anchor was the problem.
with seeded as (
    select flashpoint_id, anchor_zone_id from {{ ref('flashpoints') }}
)

select
    s.flashpoint_id,
    s.anchor_zone_id,
    f.anchor_latitude,
    f.anchor_longitude
from seeded as s
left join {{ ref('fct_flashpoint') }} as f
    on f.flashpoint_id = s.flashpoint_id
where f.flashpoint_id is null
    or f.anchor_latitude is null
    or f.anchor_longitude is null
    or f.zones_in_circle = 0
