-- Grain: one row per player per fetch. The raw file is already snake_case. Rows with no scraped_at are queue placeholders for names not fetched yet, not fetches.
select *
from {{ source('raw', 'player_profiles') }}
where scraped_at is not null
