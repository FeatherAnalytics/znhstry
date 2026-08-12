{#
    Great-circle distance in kilometres between two points.

    A macro rather than a repeated expression because the same formula has to hold in
    four places -- this project's models, `distance.py`, `mazClusters.ts` and the ad-hoc
    queries behind the flashpoint analysis -- and a circle that means one thing in a
    statistic and another on the map is the failure worth designing out.

    `EARTH_RADIUS_KM` is shared with the Python and TypeScript sides by having the same
    value, not by any mechanism. `least(1.0, ...)` guards the arcsine: floating point can
    push a coincident pair a hair above 1 and asin would return NaN for a distance of
    zero.
#}
{%- macro haversine_km(a_lat, a_lon, b_lat, b_lon) -%}
6371.0088 * 2 * asin(sqrt(least(1.0,
    pow(sin(radians(({{ b_lat }}) - ({{ a_lat }})) / 2), 2)
    + cos(radians({{ a_lat }})) * cos(radians({{ b_lat }}))
      * pow(sin(radians(({{ b_lon }}) - ({{ a_lon }})) / 2), 2)
)))
{%- endmacro -%}
