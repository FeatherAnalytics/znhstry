select
    "countryid"   as country_id,
    "Code"        as country_code,
    "Description" as country_name
from {{ source('raw', 'countries') }}
