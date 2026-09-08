-- Grain: one row per tournament month.
select
    "Month"        as tournament_month,
    "StackingDays" as stacking_days,
    "BattleDays"   as battle_days,
    "EndsAtUtc"    as ends_at,
    "Winner"       as winner
from {{ source('raw', 'atlantis_tournaments') }}
