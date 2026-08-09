-- Grain: one row per battle report.
--
-- Column names in the source carry spaces, so every reference needs quoting. The raw
-- Parquet keeps all 77 columns verbatim; this renames the ones with a consumer. The
-- rest are the per-weapon-per-faction launch breakdown -- fifteen weapons times four
-- factions -- which nothing reads yet and which is one `select` away in raw when
-- something does.
--
-- `Country = 'Atlantis'` is the **tournament world**, not test data. 15,837 reports
-- across 2,812 tournament zones and twelve years, and they carry the heaviest fighting
-- in the game: a median 36 active players against 6 for a mapped zone.
--
-- They are shaped differently from a geographic report and every field has to be read
-- accordingly. `Zone ID` is negative, `Region` holds the owning faction rather than a
-- place (Central, Legion, Swarm, Faceless), and `Zone Name` is a player handle. The
-- negative id is exact and total -- all 15,837 Atlantis reports have one and no other
-- report does -- so it is the discriminator, with the country name as the readable name
-- for it.
--
-- The flag is surfaced rather than filtered here. A tournament report is real data that
-- simply cannot be drawn on a map, which is a different thing from data to throw away.
select
    "Battle Report Number"           as battle_report_number,
    cast("Zone ID" as integer)       as zone_id,
    "Date"                           as battle_date,
    -- On a tournament report these three mean player handle, owning faction, and the
    -- literal string 'Atlantis'. Named `reported_*` because they are what the page
    -- said, not a resolved place -- geography comes from dim_zone.
    "Zone Name"                      as reported_zone_name,
    "Region"                         as reported_region_name,
    "Country"                        as reported_country_name,
    cast("Zone ID" as integer) < 0   as is_tournament,

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
