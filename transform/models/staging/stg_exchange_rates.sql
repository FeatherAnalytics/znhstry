-- Grain: one row per UTC date.
select rate_date, observed_at, qredits_per_cube, source
from {{ source('raw', 'exchange_rates') }}
