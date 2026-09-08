-- Grain: one row per player, faction, and pair of consecutive observations
-- within one tournament month. A player's first observation yields no row.
with lagged as (
    select
        tournament_month,
        faction,
        player_name,
        observed_at,
        lag(observed_at) over (
            partition by tournament_month, faction, player_name
            order by observed_at
        ) as previous_observed_at,
        launches,
        lag(launches) over (
            partition by tournament_month, faction, player_name
            order by observed_at
        ) as previous_launches,
        tournament_million_kills,
        weekly_million_kills
    from {{ ref('stg_atlantis_leaderboard') }}
)

select
    tournament_month,
    faction,
    player_name,
    observed_at,
    previous_observed_at,
    epoch(observed_at - previous_observed_at) / 60.0 as minutes,
    launches,
    launches - previous_launches as launches_gained,
    (launches - previous_launches) / (epoch(observed_at - previous_observed_at) / 60.0) * 60.0
        as launches_per_hour,
    tournament_million_kills,
    weekly_million_kills
from lagged
where previous_observed_at is not null
