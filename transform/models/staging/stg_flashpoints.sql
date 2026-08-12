-- The curated flashpoints, as seeded.
--
-- A seed rather than a source, and deliberately so: these were found by querying the
-- whole 9.9M-event record and reading the answers, which is not something a model can
-- rediscover. Keeping them in version control is what makes the export reproducible and
-- adding one a one-line diff.
--
-- **Two windows, not one.** `board_*` is the flashpoint's own days - what counts as
-- being on the leaderboard - and `run_*` is what playback covers. Collapsing them
-- breaks the long ones: Adelaide's campaign runs 2024-08-20 to 10-17 and 70 distinct
-- zones reach the leaderboard across it, most of the circle's active zones, so a single
-- window turns "the fight against its surroundings" into "activity against inactivity".
-- Adelaide's board is its three tightest days while playback still covers the campaign.
--
-- The anchor is a `ZoneId`, never a coordinate. Coordinates here would be a second copy
-- of what `dim_zone` already holds and a second chance to disagree - the same reason the
-- MAZ payload carries none. And never a name: `Description` is not unique, and
-- 2026-06-13 has two different zones both called Diamond Springs.
--
-- Resolving that id to a place is `int_flashpoints`' job, not this model's. Staging reads
-- the source and renames; reaching into `dim_zone` from here would put a mart upstream of
-- a staging view and invert the project's own layering.
select
    flashpoint_id,
    label,
    blurb,
    anchor_zone_id,
    board_start,
    board_end,
    run_start,
    run_end,
    radius_km
from {{ ref('flashpoints') }}
