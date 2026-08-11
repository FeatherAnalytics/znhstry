-- (zone_id, observed_at) is the grain of the event spine, and a total order.
--
-- The export sorts by observed_at rather than activity_date precisely because
-- 653,071 zone-days carry more than one event: with a tie, DuckDB's parallel
-- sort emits them in whatever order it finishes in, and the client takes the
-- last row in file order as the day's outcome. That reasoning only holds while
-- this pair is unique across all 9.88M rows, so a duplicate here is a silent
-- correctness bug downstream rather than a cosmetic one.
select
    zone_id,
    observed_at,
    count(*) as rows_found
from {{ ref('fct_zone_events') }}
group by 1, 2
having count(*) > 1
