-- Grain: one row per tournament month, player, and attributed faction.
with player_agg as (
    select
        tournament_month,
        player_name,
        sum(launches) as launches,
        sum(bots_killed) as bots_killed,
        sum(bots_lost) as bots_lost,
        count(distinct battle_report_number) as reports
    from {{ ref('fct_atlantis_zone_player_daily') }}
    group by 1, 2
),

factions as (
    select
        cast("Month" as date) as tournament_month,
        "PlayerName" as player_name,
        "Faction" as faction,
        "FactionSource" as faction_source,
        "IsMercenary" as is_mercenary,
        "MercenaryEvidence" as mercenary_evidence
    from {{ source('raw', 'battlestats_player_factions') }}
),

attributed as (
    select
        pa.tournament_month,
        pa.player_name,
        coalesce(f.faction, 'Unconfirmed') as faction,
        coalesce(f.faction_source, 'none') as faction_source,
        coalesce(f.is_mercenary, false) as is_mercenary,
        f.mercenary_evidence,
        pa.launches,
        pa.bots_killed,
        pa.bots_lost,
        pa.reports
    from player_agg pa
    left join factions f
        on  f.tournament_month = pa.tournament_month
        and f.player_name      = pa.player_name
),

faction_totals as (
    select tournament_month, faction, sum(launches) as faction_launches
    from attributed
    where faction <> 'Unconfirmed'
    group by 1, 2
),

placements as (
    select tournament_month, first_place, second_place, third_place
    from {{ ref('dim_atlantis_tournament_derived') }}
),

pools as (
    select
        d.tournament_month,
        p.first_pool,
        p.second_pool,
        p.third_pool
    from {{ ref('dim_atlantis_tournament_derived') }} d
    join {{ ref('atlantis_pools') }} p
        on p.effective_from = (
            select max(p2.effective_from)
            from {{ ref('atlantis_pools') }} p2
            where p2.effective_from <= d.tournament_month
        )
)

select
    a.tournament_month,
    a.player_name,
    a.faction,
    a.faction_source,
    a.is_mercenary,
    a.mercenary_evidence,
    a.launches,
    a.bots_killed,
    a.bots_lost,
    a.reports,
    case when a.faction = 'Unconfirmed' then null else
        row_number() over (
            partition by a.tournament_month, a.faction
            order by a.launches desc, a.player_name
        )
    end as rank_in_faction,
    case when a.faction = 'Unconfirmed' then null else
        a.launches * 1.0 / nullif(ft.faction_launches, 0)
    end as share,
    case a.faction
        when pl.first_place  then po.first_pool
        when pl.second_place then po.second_pool
        when pl.third_place  then po.third_pool
    end as pool,
    case when a.faction = 'Unconfirmed' then null else
        case a.faction
            when pl.first_place  then po.first_pool
            when pl.second_place then po.second_pool
            when pl.third_place  then po.third_pool
        end * (a.launches * 1.0 / nullif(ft.faction_launches, 0))
    end as qredits_estimate
from attributed a
left join faction_totals ft
    on  ft.tournament_month = a.tournament_month
    and ft.faction          = a.faction
left join placements pl on pl.tournament_month = a.tournament_month
left join pools po on po.tournament_month = a.tournament_month
