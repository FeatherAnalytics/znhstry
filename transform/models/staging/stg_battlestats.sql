-- Grain: one row per battle report.
--
-- Column names in the source carry spaces, so every reference needs quoting. The raw
-- Parquet keeps all 77 columns verbatim; this renames the ones with a consumer. The
-- rest are the per-weapon-per-faction launch breakdown -- fifteen weapons times four
-- factions -- which nothing reads yet and which is one `select` away in raw when
-- something does.
--
-- `Country = 'Atlantis'` marks QONQR's test and tutorial zones. They are a quarter of
-- the rows and they are not real places, so the flag is surfaced here and the mart
-- drops them, rather than filtering invisibly at this layer.
select
    "Battle Report Number"           as battle_report_number,
    cast("Zone ID" as integer)       as zone_id,
    "Date"                           as battle_date,
    "Zone Name"                      as reported_zone_name,
    "Region"                         as reported_region_name,
    "Country"                        as reported_country_name,
    "Country" = 'Atlantis'           as is_test_zone,

    "Legion Starting Bots"           as legion_starting_bots,
    "Swarm Starting Bots"            as swarm_starting_bots,
    "Faceless Starting Bots"         as faceless_starting_bots,
    "Legion Ending Bots"             as legion_ending_bots,
    "Swarm Ending Bots"              as swarm_ending_bots,
    "Faceless Ending Bots"           as faceless_ending_bots,

    "Total Active Players"           as total_active_players,
    "Legion Total Active Players"    as legion_active_players,
    "Swarm Total Active Players"     as swarm_active_players,
    "Faceless Total Active Players"  as faceless_active_players,

    "Total Launches"                 as total_launches,
    "Bots Launched"                  as bots_launched,
    "Bots Killed"                    as bots_killed,
    "Bots Lost"                      as bots_lost
from {{ source('raw', 'battlestats') }}
