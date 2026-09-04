-- Grain: one row per tournament month.
select
    "Month"        as tournament_month,
    "StackingDays" as stacking_days,
    "BattleDays"   as battle_days,
    "EndsAtUtc"    as ends_at
from {{ source('raw', 'atlantis_tournaments') }}
