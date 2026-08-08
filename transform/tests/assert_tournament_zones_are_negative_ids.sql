-- Tournament reports and negative zone ids must be the same set.
--
-- `is_tournament` keys off the negative id, and every downstream decision about what
-- can be drawn on a map follows from it. The two signals agree exactly today -- all
-- 15,837 Atlantis reports carry a negative id and no other report does -- so a report
-- where they disagree means the portal has changed how it identifies a tournament
-- zone, and the geographic marts would start either dropping real places or trying to
-- plot a zone that has no coordinates.
--
-- Returns rows if either signal appears without the other.
select
    battle_report_number,
    zone_id,
    reported_country_name,
    is_tournament
from {{ ref('stg_battlestats') }}
where (reported_country_name = 'Atlantis') <> (zone_id < 0)
