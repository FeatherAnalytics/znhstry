-- Grain: one row per flashpoint per zone inside its circle.
--
-- Membership is by great-circle distance from the anchor, and the bounding box in front
-- of it is padded by 5%. 111.32 km per degree of latitude is a mid-latitude average, so
-- a real degree is shorter and an unpadded box is narrower than the radius it stands
-- for -- it would clip edge zones before the haversine ever ran. `export.py` carries the
-- same `_BBOX_MARGIN` for the same reason.
--
-- `on_the_board` is measured over the **board** window, never the run window and never
-- all time. The question every downstream readout asks is what the reported fight did to
-- everything around it, so a zone counts as part of the fight only on the days the fight
-- was actually reported. Widen this to the run window and Adelaide's 9 board zones
-- become 70 of its 193 -- at which point the two groups are "active" and "inactive"
-- rather than "the fight" and "its surroundings", and the chart's labels are lying.
with board as (
    select distinct
        f.flashpoint_id,
        b.zone_id
    from {{ ref('int_flashpoints') }} as f
    inner join {{ ref('fct_zone_battles') }} as b
        on b.battle_date between f.board_start and f.board_end
),

measured as (
    select
        f.flashpoint_id,
        f.radius_km,
        z.zone_id,
        z.zone_name,
        z.latitude,
        z.longitude,
        b.zone_id is not null as on_the_board,
        {{ haversine_km('f.anchor_latitude', 'f.anchor_longitude', 'z.latitude', 'z.longitude') }}
            as km_from_anchor
    from {{ ref('int_flashpoints') }} as f
    inner join {{ ref('dim_zone') }} as z
        on abs(z.latitude - f.anchor_latitude) <= f.radius_km / 110.574 * 1.05
    left join board as b
        on b.flashpoint_id = f.flashpoint_id
        and b.zone_id = z.zone_id
)

select
    flashpoint_id,
    zone_id,
    zone_name,
    latitude,
    longitude,
    on_the_board,
    km_from_anchor
from measured
where km_from_anchor <= radius_km
