-- On finished months, the banner's winner must equal the computed first place.
-- A mismatch means the placement rule disagrees with what the game decided.
select
    tournament_month,
    winner,
    first_place
from {{ ref('dim_atlantis_tournament') }}
where is_finished
  and winner is not null
  and winner <> first_place
