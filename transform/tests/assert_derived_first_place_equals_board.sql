-- Derived first place must match the board's on every finished board month
-- where battle days were detected. Months with zero battle days (the 2019
-- faction-launch anomaly) have no placement to compare.
select
    d.tournament_month,
    d.first_place as derived,
    t.first_place as board
from {{ ref('dim_atlantis_tournament_derived') }} d
join {{ ref('dim_atlantis_tournament') }} t
    on t.tournament_month = d.tournament_month
where t.is_finished
  and d.battle_days > 0
  and d.first_place <> t.first_place
