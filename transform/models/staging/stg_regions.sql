select
    "regionid"    as region_id,
    "countryid"   as country_id,
    "description" as region_name
from {{ source('raw', 'regions') }}
