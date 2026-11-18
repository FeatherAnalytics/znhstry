-- Grain: one row per player per fetch of their portal profile, including fetches that found no profile.
select
    lower(player_name) as player_key,
    *
from {{ ref('stg_player_profiles') }}
