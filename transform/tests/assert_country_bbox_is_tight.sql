-- A longitude span over 240 degrees means the antimeridian normalization failed and
-- the bbox covers most of the globe, making that country a candidate for every point.
-- Antarctica (232 degrees, 7 zones) is the widest legitimate span.
select country_id, country_name, max_longitude - min_longitude as lon_span
from {{ ref('dim_country') }}
where max_longitude - min_longitude > 240
