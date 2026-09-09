-- Grain: one row per player per faction per hourly observation.
--
-- Faction is part of the grain because a player can launch for more than one faction in
-- a month, and the page lists them once under each. Rank is derived rather than stored:
-- `rank()` leaves ties sharing a position and skipping the next, which is how the site
-- numbers them. Launch counts reset to zero on the 1st, so `tournament_month` is the
-- window every count belongs to.
--
-- The hive `year` column is a physical artifact of the layout and is not selected.
select
    "ObservedAtUtc"                              as observed_at,
    "Faction"                                    as faction,
    "PlayerName"                                 as player_name,
    "Launches"                                   as launches,
    "TournamentMillionKills"                     as tournament_million_kills,
    "WeeklyMillionKills"                         as weekly_million_kills,
    coalesce("Source", 'portal')                 as source,
    rank() over (
        partition by "ObservedAtUtc", "Faction"
        order by "Launches" desc
    )                                            as launch_rank,
    cast(date_trunc('month', "ObservedAtUtc") as date) as tournament_month,
    -- Per month: a finished tournament marks its final standings, a running one its
    -- current board.
    "ObservedAtUtc" = max("ObservedAtUtc") over (
        partition by date_trunc('month', "ObservedAtUtc")
    )                                            as is_latest
from {{ source('raw', 'atlantis_leaderboard') }}
