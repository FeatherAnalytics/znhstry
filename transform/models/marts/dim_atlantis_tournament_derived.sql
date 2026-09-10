-- Grain: one row per tournament month, derived entirely from battle reports.
with reports as (
    select
        date_trunc('month', battle_date)::date as tournament_month,
        battle_report_number,
        battle_date,
        reported_zone_name,
        reported_region_name,
        total_launches,
        legion_ending_bots,
        swarm_ending_bots,
        faceless_ending_bots,
        legion_total_launches,
        swarm_total_launches,
        faceless_total_launches,
        total_active_players
    from {{ ref('stg_battlestats') }}
    where is_tournament
),

day_stats as (
    select
        tournament_month,
        battle_date,
        count(*) as day_reports,
        count(*) filter (
            where (case when legion_total_launches > 0 then 1 else 0 end
                 + case when swarm_total_launches > 0 then 1 else 0 end
                 + case when faceless_total_launches > 0 then 1 else 0 end) >= 2
        ) as multi_faction_zones
    from reports
    group by 1, 2
),

day_class as (
    select *,
        case
            when day_reports >= 10 and multi_faction_zones = 0 then 'stacking'
            when multi_faction_zones >= 10 then 'battle'
            else 'other'
        end as day_type
    from day_stats
),

schedule as (
    select
        tournament_month,
        count(*) filter (where day_type = 'stacking') as stacking_days,
        count(*) filter (where day_type = 'battle') as battle_days,
        max(battle_date) filter (where day_type = 'battle') as last_battle_day,
        min(battle_date) as first_report_day
    from day_class
    group by 1
),

last_reports as (
    select distinct on (r.tournament_month, r.reported_zone_name, r.reported_region_name)
        r.tournament_month,
        r.reported_zone_name,
        r.reported_region_name,
        r.legion_ending_bots,
        r.swarm_ending_bots,
        r.faceless_ending_bots,
        case
            when greatest(r.legion_ending_bots, r.swarm_ending_bots, r.faceless_ending_bots) = 0 then null
            when r.legion_ending_bots = greatest(r.legion_ending_bots, r.swarm_ending_bots, r.faceless_ending_bots) then 'Legion'
            when r.swarm_ending_bots = greatest(r.legion_ending_bots, r.swarm_ending_bots, r.faceless_ending_bots) then 'Swarm'
            else 'Faceless'
        end as holder
    from reports r
    join schedule s
        on  s.tournament_month = r.tournament_month
        and s.last_battle_day is not null
        and r.battle_date <= s.last_battle_day
    order by r.tournament_month, r.reported_zone_name, r.reported_region_name, r.battle_date desc
),

faction_zones as (
    select
        tournament_month,
        holder,
        count(*) as zones_held,
        sum(legion_ending_bots + swarm_ending_bots + faceless_ending_bots) as total_bots
    from last_reports
    where holder is not null
    group by 1, 2
),

prime_holder as (
    select tournament_month, holder as prime_holder
    from last_reports
    where reported_region_name = 'Central'
),

all_factions as (
    select name as faction from (values ('Legion'), ('Swarm'), ('Faceless')) t(name)
),

faction_standings as (
    select
        s.tournament_month,
        f.faction,
        coalesce(fz.zones_held, 0) as zones_held,
        coalesce(fz.total_bots, 0) as total_bots
    from schedule s
    cross join all_factions f
    left join faction_zones fz
        on  fz.tournament_month = s.tournament_month
        and fz.holder           = f.faction
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

month_agg as (
    select
        tournament_month,
        count(distinct (reported_zone_name, reported_region_name)) as zone_count,
        count(distinct battle_report_number) as reports,
        sum(total_launches) as launches_total
    from reports
    group by 1
),

players as (
    select
        date_trunc('month', battle_date)::date as tournament_month,
        count(distinct player_name) as players
    from {{ ref('fct_atlantis_zone_player_daily') }}
    group by 1
)

select
    s.tournament_month,
    cast(s.stacking_days as smallint) as stacking_days,
    cast(s.battle_days as smallint) as battle_days,
    cast(s.tournament_month as timestamp) as starts_at,
    cast(s.last_battle_day + interval '1 day' as timestamp) as ends_at,
    case
        when t.ends_at is not null and cast(s.last_battle_day + interval '1 day' as timestamp) = t.ends_at
            then cast(0 as smallint)
        when s.tournament_month < '2024-12-01'
            then cast(1 as smallint)
        else cast(0 as smallint)
    end as end_tolerance_days,
    case
        when s.stacking_days >= 2 and s.battle_days >= 8 then 'long format'
        else null
    end as schedule_note,
    s.zone_count,
    r1.faction as first_place,
    r1.zones_held as first_zones,
    r2.faction as second_place,
    r2.zones_held as second_zones,
    r3.faction as third_place,
    r3.zones_held as third_zones,
    case
        when r1.zones_held > r2.zones_held then 'none'
        when r1.zones_held = r2.zones_held
            and coalesce(ph.prime_holder = r1.faction, false) != coalesce(ph.prime_holder = r2.faction, false)
            then 'prime'
        when r1.zones_held = r2.zones_held then 'bots'
        else 'none'
    end as placement_tiebreak,
    r1.faction as winner,
    s.reports,
    coalesce(p.players, 0) as players,
    s.launches_total,
    t.tournament_month is not null as has_board,
    'reports' as source
from (
    select sc.*, ma.zone_count, ma.reports, ma.launches_total
    from schedule sc
    join month_agg ma on ma.tournament_month = sc.tournament_month
) s
left join ranked r1 on r1.tournament_month = s.tournament_month and r1.placement = 1
left join ranked r2 on r2.tournament_month = s.tournament_month and r2.placement = 2
left join ranked r3 on r3.tournament_month = s.tournament_month and r3.placement = 3
left join prime_holder ph on ph.tournament_month = s.tournament_month
left join players p on p.tournament_month = s.tournament_month
left join {{ ref('dim_atlantis_tournament') }} t on t.tournament_month = s.tournament_month
