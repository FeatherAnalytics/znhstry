-- Grain: one row per flashpoint. Dense -- every seeded row appears, including the ones
-- the changelog cannot describe.
--
-- This is the manifest the export packs and the viewer's picker reads: where to point the
-- map, what window to run, how many zones are involved, and whether the impact readout
-- can be shown at all.
--
-- **`changelog_covered` exists because absence and zero are different answers.** For
-- Chermignac, Breda, Williamsport, South Whittier and both Kent days, the zones that were
-- fighting have no events anywhere in the run window -- the record before late 2018 is a
-- thin stream of first sightings, and 2019 is the collection gap. A chart drawn over that
-- is a flat line at zero, which reads as a calm neighborhood and is the opposite of the
-- truth. The flag is computed rather than seeded so it cannot go stale against a record
-- that keeps growing.
with evidence as (
    select
        flashpoint_id,
        sum(zones_moving) filter (where on_the_board) as board_zone_days
    from {{ ref('fct_flashpoint_impact') }}
    group by 1
),

circle as (
    select
        flashpoint_id,
        count(*) as zones_in_circle,
        count(*) filter (where on_the_board) as zones_on_board
    from {{ ref('fct_flashpoint_zone') }}
    group by 1
)

select
    f.flashpoint_id,
    f.label,
    f.blurb,
    f.anchor_zone_id,
    f.anchor_zone_name,
    f.anchor_latitude,
    f.anchor_longitude,
    f.board_start,
    f.board_end,
    f.run_start,
    f.run_end,
    f.radius_km,
    c.zones_in_circle,
    c.zones_on_board,
    -- Covered means the zones that were reported fighting have events to show for it.
    -- Neighbors moving is not enough: Chermignac's circle has five neighbor zones with
    -- events in 2017 and the anchor itself has none, so a check on the circle as a whole
    -- would call that covered and draw a chart about the wrong zones.
    coalesce(e.board_zone_days, 0) > 0 as changelog_covered
from {{ ref('int_flashpoints') }} as f
inner join circle as c
    on c.flashpoint_id = f.flashpoint_id
left join evidence as e
    on e.flashpoint_id = f.flashpoint_id
