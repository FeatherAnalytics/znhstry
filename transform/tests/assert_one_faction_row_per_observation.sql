-- `marts` refuses a table whose sort key has ties, so a duplicate here stops the nightly
-- publish, and the Atlantis export would silently keep whichever tied row sorted last.
select
    tournament_month,
    faction,
    observed_at,
    count(*) as rows_at_this_observation
from {{ ref('fct_atlantis_faction_hourly') }}
group by 1, 2, 3
having count(*) > 1
