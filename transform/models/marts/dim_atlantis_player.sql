-- Grain: one row per player with at least one top-three finish, across every faction.
-- Zone names vary in case from month to month (PolarBear, Polarbear), so the key is lowered
-- and the name shown is the newest spelling.
select
    arg_max(player_name, tournament_month) as player_name,
    count(*) as top_three,
    count(*) filter (where placement = 1) as first_place,
    count(*) filter (where placement = 2) as second_place,
    count(*) filter (where placement = 3) as third_place,
    count(*) filter (where placement is null) as unordered,
    list(distinct faction order by faction) as factions,
    min(tournament_month) as first_month,
    max(tournament_month) as last_month
from {{ ref('fct_atlantis_placement') }}
group by lower(player_name)
