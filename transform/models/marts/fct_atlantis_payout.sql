-- Grain: one row per tournament month, faction, and player on the board at
-- the last observation.
with last_board as (
    select
        tournament_month,
        faction,
        player_name,
        launches
    from {{ ref('stg_atlantis_leaderboard') }}
    where is_latest
),

faction_totals as (
    select
        tournament_month,
        faction,
        sum(launches) as faction_launches
    from last_board
    group by 1, 2
),

tournament as (
    select
        tournament_month,
        is_finished,
        first_place,  second_place,  third_place,
        first_pool,   second_pool,   third_pool
    from {{ ref('dim_atlantis_tournament') }}
)

select
    lb.tournament_month,
    lb.faction,
    lb.player_name,
    lb.launches,
    ft.faction_launches,
    lb.launches * 1.0 / ft.faction_launches as share,
    case lb.faction
        when t.first_place  then cast(1 as smallint)
        when t.second_place then cast(2 as smallint)
        when t.third_place  then cast(3 as smallint)
    end as placement,
    case lb.faction
        when t.first_place  then t.first_pool
        when t.second_place then t.second_pool
        when t.third_place  then t.third_pool
    end as pool,
    case lb.faction
        when t.first_place  then t.first_pool
        when t.second_place then t.second_pool
        when t.third_place  then t.third_pool
    end * (lb.launches * 1.0 / ft.faction_launches) as qredits,
    not t.is_finished as is_estimate
from last_board lb
join faction_totals ft
    on  ft.tournament_month = lb.tournament_month
    and ft.faction          = lb.faction
join tournament t on t.tournament_month = lb.tournament_month
