-- Every zone in a flashpoint's circle is in exactly one group.
--
-- The impact chart's two lines are only a decomposition if this holds. A zone counted in
-- both would be added to the fight and to its surroundings at once, and the two lines
-- would sum to more than the circle actually moved -- invisible, because both lines stay
-- plausible and no total is printed anywhere for a reader to check.
select
    flashpoint_id,
    zone_id,
    count(*) as rows_for_this_zone
from {{ ref('fct_flashpoint_zone') }}
group by 1, 2
having count(*) > 1
