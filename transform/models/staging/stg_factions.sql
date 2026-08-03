-- 0 uncaptured, 1 legion, 2 swarm, 3 faceless.
select
    "id"   as faction_id,
    "name" as faction_name
from {{ source('raw', 'factions') }}
