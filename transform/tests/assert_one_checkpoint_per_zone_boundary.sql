-- Exactly one checkpoint row per zone per year boundary.
--
-- Regression guard. The first version of fct_zone_checkpoints compared dates
-- instead of timestamps, which silently dropped every boundary an event
-- landed on -- 19,062 of them. Duplicates would mean the reverse: overlapping
-- validity windows. Both show up here.
select zone_id, checkpoint_date, count(*) as rows_found
from {{ ref('fct_zone_checkpoints') }}
group by 1, 2
having count(*) > 1
