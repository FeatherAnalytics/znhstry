-- Grain: one row per UTC date. Joins to any dated fact on its date, e.g. fct_zone_battles.battle_date.
select
    rate_date,
    qredits_per_cube,
    source
from {{ ref('stg_exchange_rates') }}
