-- Grain: one row per player, case-insensitive. Profile fields are the newest fetch that found a profile; the check columns cover every fetch, so a player renamed since is still visible as not found.
with fetches as (
    select * from {{ ref('fct_player_profile') }}
),

checks as (
    select
        player_key,
        min(scraped_at) as first_checked_at,
        max(scraped_at) as last_checked_at,
        arg_max(found, scraped_at) as found_on_last_check
    from fetches
    group by player_key
),

latest_found as (
    select * exclude (player_name, found)
    from fetches
    where found
    qualify row_number() over (partition by player_key order by scraped_at desc) = 1
)

select
    c.player_key,
    l.* exclude (player_key),
    c.first_checked_at,
    c.last_checked_at,
    c.found_on_last_check
from checks c
left join latest_found l using (player_key)
