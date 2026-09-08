-- Grain: one row per player per battle report, for tournament zones only.
-- Reads per-player rows where the scraper has them (with faction and badges),
-- falls back to the packed string for older reports.
with has_rows as (
    select distinct "BattleReportNumber" as battle_report_number
    from {{ source('raw', 'battlestats_players') }}
),

from_rows as (
    select
        cast(p."BattleReportNumber" as bigint) as battle_report_number,
        cast(p."BattleDate" as date) as battle_date,
        cast(p."ZoneName" as varchar) as zone_name,
        cast(p."Faction" as varchar) as faction,
        cast(p."Rank" as integer) as rank,
        cast(p."PlayerName" as varchar) as player_name,
        cast(p."Launches" as bigint) as launches,
        cast(p."BotsKilled" as bigint) as bots_killed,
        cast(p."BotsLost" as bigint) as bots_lost,
        cast(p."TournamentMillionKills" as boolean) as tournament_million_kills,
        cast(p."WeeklyMillionKills" as boolean) as weekly_million_kills
    from {{ source('raw', 'battlestats_players') }} p
    where p."BattleReportNumber" in (
        select battle_report_number from {{ ref('stg_battlestats') }}
        where is_tournament
    )
),

from_packed as (
    select
        cast(s.battle_report_number as bigint) as battle_report_number,
        cast(s.battle_date as date) as battle_date,
        cast(s.zone_name as varchar) as zone_name,
        cast(null as varchar) as faction,
        cast(s.fields[i * 5 + 1] as integer) as rank,
        cast(s.fields[i * 5 + 2] as varchar) as player_name,
        cast(s.fields[i * 5 + 3] as bigint) as launches,
        cast(s.fields[i * 5 + 4] as bigint) as bots_killed,
        cast(s.fields[i * 5 + 5] as bigint) as bots_lost,
        cast(null as boolean) as tournament_million_kills,
        cast(null as boolean) as weekly_million_kills
    from (
        select "Battle Report Number" as battle_report_number,
               "Date" as battle_date,
               "Zone Name" as zone_name,
               string_split(players, ',') as fields,
               (length(players) - length(replace(players, ',', '')) + 1) // 5 as player_count
        from {{ source('raw', 'battlestats') }}
        where "Country" = 'Atlantis'
          and players is not null
          and length(players) > 0
          and "Battle Report Number" not in (select battle_report_number from has_rows)
    ) s, unnest(generate_series(0, s.player_count - 1)) as t(i)
)

select * from from_rows
union all
select * from from_packed
