-- Grain: one row per player per battle report, for tournament zones only.
select bp.*
from {{ ref('stg_battle_players') }} bp
where bp.battle_report_number in (
    select battle_report_number from {{ ref('stg_battlestats') }}
    where is_tournament
)
