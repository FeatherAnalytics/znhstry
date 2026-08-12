-- `changelog_covered` must agree with whether on-the-board rows actually exist.
--
-- This is the flag that decides whether the viewer draws an impact chart or prints a
-- caveat, and it is the only thing standing between a reader and a flat line at zero that
-- reads as a quiet neighborhood. Five of the ten flashpoints predate usable changelog
-- coverage, so the false case is the common one and has to stay correct as the record
-- grows past the windows.
with evidence as (
    select
        flashpoint_id,
        sum(zones_moving) filter (where on_the_board) as board_zone_days
    from {{ ref('fct_flashpoint_impact') }}
    group by 1
)

select
    f.flashpoint_id,
    f.changelog_covered,
    coalesce(e.board_zone_days, 0) as board_zone_days
from {{ ref('fct_flashpoint') }} as f
left join evidence as e
    on e.flashpoint_id = f.flashpoint_id
where f.changelog_covered != (coalesce(e.board_zone_days, 0) > 0)
