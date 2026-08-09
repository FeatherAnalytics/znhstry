-- 0 uncaptured, 1 legion, 2 swarm, 3 faceless.
--
-- A seed rather than a source: four rows that have never changed and are not in
-- QONQR's published drop. Extracting them meant one query to somebody else's server
-- for a constant, and leaving them as the only reason to keep that path alive.
select
    "id"   as faction_id,
    "name" as faction_name
from {{ ref('factions') }}
