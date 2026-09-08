-- Grain: one row per tournament month.
with last_obs as (
    select
        tournament_month,
        max(observed_at) as last_observed_at,
        min(observed_at) as first_observed_at,
        count(distinct observed_at) as observations
    from {{ ref('stg_atlantis_zones') }}
    group by 1
),

zone_holders as (
    select
        z.tournament_month,
        z.zone,
        z.swarm_count,
        z.legion_count,
        z.faceless_count,
        -- Tie order matches export.py's _leader: Legion > Swarm > Faceless.
        -- A tie has not occurred in the data and cannot be resolved from it.
        case
            when greatest(z.legion_count, z.swarm_count, z.faceless_count) = 0 then null
            when z.legion_count = greatest(z.legion_count, z.swarm_count, z.faceless_count) then 'Legion'
            when z.swarm_count = greatest(z.legion_count, z.swarm_count, z.faceless_count) then 'Swarm'
            else 'Faceless'
        end as holder
    from {{ ref('stg_atlantis_zones') }} z
    join last_obs lo
        on  lo.tournament_month  = z.tournament_month
        and lo.last_observed_at  = z.observed_at
),

zones_held as (
    select
        tournament_month,
        holder,
        count(*) as zones_held
    from zone_holders
    where holder is not null
    group by 1, 2
),

faction_bots as (
    select
        tournament_month,
        'Legion'   as faction, sum(legion_count)   as total_bots
    from zone_holders group by 1
    union all
    select
        tournament_month,
        'Swarm'    as faction, sum(swarm_count)    as total_bots
    from zone_holders group by 1
    union all
    select
        tournament_month,
        'Faceless'  as faction, sum(faceless_count) as total_bots
    from zone_holders group by 1
),

factions as (
    select name as faction from (values ('Legion'), ('Swarm'), ('Faceless')) t(name)
),

faction_standings as (
    select
        lo.tournament_month,
        f.faction,
        coalesce(zh.zones_held, 0) as zones_held,
        coalesce(fb.total_bots, 0) as total_bots
    from last_obs lo
    cross join factions f
    left join zones_held zh
        on  zh.tournament_month = lo.tournament_month
        and zh.holder           = f.faction
    left join faction_bots fb
        on  fb.tournament_month = lo.tournament_month
        and fb.faction          = f.faction
),

prime_holder as (
    select tournament_month, holder as prime_holder
    from zone_holders
    where zone = 'Prime'
),

ranked as (
    select
        fs.tournament_month,
        fs.faction,
        fs.zones_held,
        fs.total_bots,
        row_number() over (
            partition by fs.tournament_month
            order by
                fs.zones_held desc,
                case when fs.faction = ph.prime_holder then 0 else 1 end,
                fs.total_bots desc,
                case fs.faction when 'Legion' then 1 when 'Swarm' then 2 else 3 end
        ) as placement
    from faction_standings fs
    left join prime_holder ph on ph.tournament_month = fs.tournament_month
),

pools as (
    select
        t.tournament_month,
        p.first_pool,
        p.second_pool,
        p.third_pool
    from last_obs t
    join {{ ref('atlantis_pools') }} p
        on p.effective_from = (
            select max(p2.effective_from)
            from {{ ref('atlantis_pools') }} p2
            where p2.effective_from <= t.tournament_month
        )
),

players_at_last as (
    select
        tournament_month,
        count(distinct (faction, player_name)) as players,
        sum(launches) as launches_total
    from {{ ref('stg_atlantis_leaderboard') }}
    where is_latest
    group by 1
),

top_per_faction as (
    select
        tournament_month,
        faction,
        player_name,
        launches,
        row_number() over (
            partition by tournament_month, faction
            order by launches desc, player_name
        ) as rn
    from {{ ref('stg_atlantis_leaderboard') }}
    where is_latest
)

select
    t.tournament_month,
    t.stacking_days,
    t.battle_days,
    cast(t.tournament_month as timestamp) as starts_at,
    t.ends_at,
    t.winner,
    r1.faction as first_place,
    r2.faction as second_place,
    r3.faction as third_place,
    r1.zones_held as first_zones,
    r2.zones_held as second_zones,
    r3.zones_held as third_zones,
    po.first_pool,
    po.second_pool,
    po.third_pool,
    t.ends_at <= lo.last_observed_at as is_finished,
    lo.first_observed_at,
    lo.last_observed_at,
    lo.observations,
    pl.players,
    pl.launches_total,
    sw.player_name  as swarm_top_player,
    sw.launches     as swarm_top_launches,
    lg.player_name  as legion_top_player,
    lg.launches     as legion_top_launches,
    fc.player_name  as faceless_top_player,
    fc.launches     as faceless_top_launches
from {{ ref('stg_atlantis_tournaments') }} t
join last_obs lo on lo.tournament_month = t.tournament_month
join pools po on po.tournament_month = t.tournament_month
join players_at_last pl on pl.tournament_month = t.tournament_month
left join ranked r1 on r1.tournament_month = t.tournament_month and r1.placement = 1
left join ranked r2 on r2.tournament_month = t.tournament_month and r2.placement = 2
left join ranked r3 on r3.tournament_month = t.tournament_month and r3.placement = 3
left join top_per_faction sw
    on sw.tournament_month = t.tournament_month and sw.faction = 'Swarm' and sw.rn = 1
left join top_per_faction lg
    on lg.tournament_month = t.tournament_month and lg.faction = 'Legion' and lg.rn = 1
left join top_per_faction fc
    on fc.tournament_month = t.tournament_month and fc.faction = 'Faceless' and fc.rn = 1
