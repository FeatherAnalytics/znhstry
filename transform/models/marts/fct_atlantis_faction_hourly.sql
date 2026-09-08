-- Grain: one row per tournament month, faction, and observation that has at
-- least one interval ending at it.
select
    pi.tournament_month,
    pi.faction,
    pi.observed_at,
    pi.minutes,
    sum(pi.launches_gained) as launches_gained,
    sum(pi.launches_gained) / pi.minutes * 60.0 as launches_per_hour,
    count(*) filter (where pi.launches_gained > 0) as active_players,
    lb.players_on_board,
    lb.launches_total
from {{ ref('fct_atlantis_player_interval') }} pi
join (
    select
        tournament_month,
        faction,
        observed_at,
        count(*) as players_on_board,
        sum(launches) as launches_total
    from {{ ref('stg_atlantis_leaderboard') }}
    group by 1, 2, 3
) lb
    on  lb.tournament_month = pi.tournament_month
    and lb.faction          = pi.faction
    and lb.observed_at      = pi.observed_at
group by
    pi.tournament_month,
    pi.faction,
    pi.observed_at,
    pi.minutes,
    lb.players_on_board,
    lb.launches_total
