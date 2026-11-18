-- Grain: one row per player per battle report, every report. Faction and the two badges are known only where the scraper kept per-player rows; for most regular reports they are null.
select
    bp.battle_report_number,
    bp.battle_date,
    b.zone_id,
    bp.zone_name,
    b.reported_region_name as region_name,
    b.reported_country_name as country_name,
    b.is_tournament,
    lower(bp.player_name) as player_key,
    bp.player_name,
    bp.faction,
    bp.rank,
    bp.launches,
    bp.bots_killed,
    bp.bots_lost,
    bp.tournament_million_kills,
    bp.weekly_million_kills
from {{ ref('stg_battle_players') }} bp
join {{ ref('stg_battlestats') }} b using (battle_report_number)
