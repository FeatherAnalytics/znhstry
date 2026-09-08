-- Grain: one row per player per battle report, for tournament zones only.
-- The raw `players` column is a comma-separated string of repeating groups:
-- rank, player_name, launches, bots_killed, bots_lost. Capped at 50 per report.
with src as (
    select
        "Battle Report Number" as battle_report_number,
        "Date"           as battle_date,
        "Zone Name"      as zone_name,
        string_split(players, ',') as fields,
        (length(players) - length(replace(players, ',', '')) + 1) // 5 as player_count
    from {{ source('raw', 'battlestats') }}
    where "Country" = 'Atlantis'
      and players is not null
      and length(players) > 0
)

select
    s.battle_report_number,
    s.battle_date,
    s.zone_name,
    cast(s.fields[i * 5 + 1] as integer) as rank,
    s.fields[i * 5 + 2] as player_name,
    cast(s.fields[i * 5 + 3] as integer) as launches,
    cast(s.fields[i * 5 + 4] as integer) as bots_killed,
    cast(s.fields[i * 5 + 5] as integer) as bots_lost
from src s, unnest(generate_series(0, s.player_count - 1)) as t(i)
