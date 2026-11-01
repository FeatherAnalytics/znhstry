-- Grain: one row per tournament month, faction, and observation the faction
-- appears on the board. Driven from the board rather than the intervals: the
-- first observation has no interval ending at it, and dropping it loses the
-- starting launch total, which leaves each chart one point short of a line.
with board as (
    select
        tournament_month,
        faction,
        observed_at,
        count(*) as players_on_board,
        sum(launches) as launches_total
    from {{ ref('stg_atlantis_leaderboard') }}
    group by 1, 2, 3
),

intervals as (
    select
        tournament_month,
        faction,
        observed_at,
        minutes,
        sum(launches_gained) as launches_gained,
        sum(launches_gained) / minutes * 60.0 as launches_per_hour,
        count(*) filter (where launches_gained > 0) as active_players
    from {{ ref('fct_atlantis_player_interval') }}
    group by 1, 2, 3, 4
)

select
    b.tournament_month,
    b.faction,
    b.observed_at,
    i.minutes,
    i.launches_gained,
    i.launches_per_hour,
    i.active_players,
    b.players_on_board,
    b.launches_total
from board b
left join intervals i
    on  i.tournament_month = b.tournament_month
    and i.faction          = b.faction
    and i.observed_at      = b.observed_at
