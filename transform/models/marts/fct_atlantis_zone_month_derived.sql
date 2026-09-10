-- Grain: one row per tournament month, triangle, and zone name.
-- A name can appear in multiple triangles in the same month.
with battle_days as (
    select
        tournament_month,
        cast(ends_at - interval '1 day' as date) as last_battle_day
    from {{ ref('dim_atlantis_tournament_derived') }}
    where battle_days > 0
),

zone_reports as (
    select
        date_trunc('month', r.battle_date)::date as tournament_month,
        case r.reported_region_name
            when 'Central' then 'Prime'
            else r.reported_region_name
        end as triangle,
        r.reported_zone_name as zone_name,
        r.battle_date,
        r.battle_report_number,
        r.total_launches,
        r.legion_ending_bots,
        r.swarm_ending_bots,
        r.faceless_ending_bots
    from {{ ref('stg_battlestats') }} r
    join battle_days bd
        on  bd.tournament_month = date_trunc('month', r.battle_date)::date
        and r.battle_date <= bd.last_battle_day
    where r.is_tournament
),

-- Months without battle days: include all reports
no_battle as (
    select
        date_trunc('month', r.battle_date)::date as tournament_month,
        case r.reported_region_name
            when 'Central' then 'Prime'
            else r.reported_region_name
        end as triangle,
        r.reported_zone_name as zone_name,
        r.battle_date,
        r.battle_report_number,
        r.total_launches,
        r.legion_ending_bots,
        r.swarm_ending_bots,
        r.faceless_ending_bots
    from {{ ref('stg_battlestats') }} r
    where r.is_tournament
      and date_trunc('month', r.battle_date)::date not in (select tournament_month from battle_days)
),

all_zone_reports as (
    select * from zone_reports
    union all
    select * from no_battle
),

agg as (
    select
        tournament_month,
        triangle,
        zone_name,
        count(distinct battle_report_number) as reports,
        sum(total_launches) as total_launches
    from all_zone_reports
    group by 1, 2, 3
),

last_report as (
    select distinct on (tournament_month, triangle, zone_name)
        tournament_month,
        triangle,
        zone_name,
        legion_ending_bots,
        swarm_ending_bots,
        faceless_ending_bots,
        case
            when greatest(legion_ending_bots, swarm_ending_bots, faceless_ending_bots) = 0 then null
            when legion_ending_bots = greatest(legion_ending_bots, swarm_ending_bots, faceless_ending_bots) then 'Legion'
            when swarm_ending_bots = greatest(legion_ending_bots, swarm_ending_bots, faceless_ending_bots) then 'Swarm'
            else 'Faceless'
        end as holder
    from all_zone_reports
    order by tournament_month, triangle, zone_name, battle_date desc
),

prev_ranks as (
    select
        tournament_month,
        faction,
        player_name,
        rank_in_faction
    from {{ ref('fct_atlantis_player_month_derived') }}
    where rank_in_faction <= 3 and faction <> 'Unconfirmed'
)

select
    a.tournament_month,
    a.triangle,
    a.zone_name,
    a.reports,
    a.total_launches,
    lr.legion_ending_bots,
    lr.swarm_ending_bots,
    lr.faceless_ending_bots,
    lr.holder,
    case
        when a.triangle = 'Prime' then null
        when a.zone_name like 'L %' or a.zone_name like 'S %' or a.zone_name like 'F %'
            or a.zone_name like 'Legion %' or a.zone_name like 'Swarm %' or a.zone_name like 'Faceless %'
            then cast(4 as smallint)
        when pr.rank_in_faction is not null then cast(pr.rank_in_faction as smallint)
        else null
    end as position
from agg a
join last_report lr
    on  lr.tournament_month = a.tournament_month
    and lr.triangle         = a.triangle
    and lr.zone_name        = a.zone_name
left join prev_ranks pr
    on  pr.tournament_month = a.tournament_month - interval '1 month'
    and pr.faction          = case a.triangle when 'Prime' then null else a.triangle end
    and pr.player_name      = a.zone_name
