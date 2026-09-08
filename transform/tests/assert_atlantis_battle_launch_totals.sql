-- The sum of unpacked player launches must equal the report's own total
-- for reports below the 50-player cap. Capped reports have a truncated
-- list. The 42 reports where the header count exceeds the list by one
-- (multi-faction players) are excluded because their launch split is
-- partial by construction.
with per_report as (
    select
        battle_report_number,
        sum(launches) as unpacked_total,
        count(*) as player_count
    from {{ ref('stg_atlantis_battle_players') }}
    group by 1
),

report_totals as (
    select
        battle_report_number,
        total_launches,
        total_active_players
    from {{ ref('stg_battlestats') }}
    where is_tournament
)

select
    pr.battle_report_number,
    pr.unpacked_total,
    rt.total_launches as report_total,
    pr.player_count,
    rt.total_active_players as header_players
from per_report pr
join report_totals rt on rt.battle_report_number = pr.battle_report_number
where pr.player_count < 50
  and pr.player_count = rt.total_active_players
  and pr.unpacked_total <> rt.total_launches
