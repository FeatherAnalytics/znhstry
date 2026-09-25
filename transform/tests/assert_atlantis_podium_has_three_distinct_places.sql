-- A faction's month holds at most three finishers and never repeats a place.
-- More than three means a zone name that is not a player slipped past the formation filter.
select tournament_month, faction
from {{ ref('fct_atlantis_placement') }}
group by tournament_month, faction
having count(*) > 3
    or count(placement) <> count(distinct placement)
    or count(distinct lower(player_name)) <> count(*)
