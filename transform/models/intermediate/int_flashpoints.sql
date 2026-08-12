-- Grain: one row per flashpoint, resolved to a place on the map.
--
-- The join that turns a seeded `ZoneId` into coordinates. It lives here rather than in
-- staging because `dim_zone` is a mart, and a staging view depending on one puts the
-- layers the wrong way round.
--
-- **A mistyped `anchor_zone_id` drops the flashpoint rather than failing.** The inner
-- join is right - a flashpoint with no place is not a flashpoint - but it means the
-- failure mode is a picker with nine entries where ten were seeded, which looks exactly
-- like a picker with nine entries. `assert_flashpoint_anchors_all_resolve` is what makes
-- that loud.
select
    f.flashpoint_id,
    f.label,
    f.blurb,
    f.anchor_zone_id,
    f.board_start,
    f.board_end,
    f.run_start,
    f.run_end,
    f.radius_km,
    z.zone_name as anchor_zone_name,
    z.latitude as anchor_latitude,
    z.longitude as anchor_longitude
from {{ ref('stg_flashpoints') }} as f
inner join {{ ref('dim_zone') }} as z
    on f.anchor_zone_id = z.zone_id
