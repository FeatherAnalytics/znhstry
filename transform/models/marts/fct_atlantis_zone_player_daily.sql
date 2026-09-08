-- Grain: one row per player per battle report for tournament zones.
-- `zone` is the stable position key, nullable for months before September 2026
-- when `stg_atlantis_zone_months` has no names.
select
    date_trunc('month', bp.battle_date)::date as tournament_month,
    zm.zone,
    bp.zone_name,
    bp.battle_date,
    bp.player_name,
    bp.faction,
    bp.rank,
    bp.launches,
    bp.bots_killed,
    bp.bots_lost,
    bp.tournament_million_kills,
    bp.weekly_million_kills,
    bp.battle_report_number
from {{ ref('stg_atlantis_battle_players') }} bp
left join {{ ref('stg_atlantis_zone_months') }} zm
    on  zm.tournament_month = date_trunc('month', bp.battle_date)::date
    and zm.zone_name        = bp.zone_name
