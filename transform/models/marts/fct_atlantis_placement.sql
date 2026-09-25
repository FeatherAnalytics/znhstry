-- Grain: one row per tournament month, faction, and player who finished in its top three.
-- A zone named in month M honors a finish in month M - 1.
with formation as (
    select tournament_month, triangle, zone_name
    from {{ ref('fct_atlantis_zone_month_derived') }}
    where zone_name like '% DEF SHOCK' or zone_name like '% SEEK ZA' or zone_name like '% ABS MISSILES'
       or zone_name like '% Grunt' or zone_name like '% Melee' or zone_name like '% Clover'
),

page as (
    select
        tournament_month,
        split_part(zone, ' ', 1) as triangle,
        zone_name,
        cast(split_part(zone, ' ', 2) as smallint) as position
    from {{ ref('stg_atlantis_zone_months') }}
    where regexp_full_match(zone, '(Legion|Swarm|Faceless) [1-6]')
),

-- Months with no formation zones (every December so far) name all six positions.
named as (
    select d.tournament_month, d.triangle, d.zone_name, d.position
    from {{ ref('fct_atlantis_zone_month_derived') }} d
    where d.triangle <> 'Prime'
      and not exists (
          select 1 from formation f
          where f.tournament_month = d.tournament_month
            and f.triangle = d.triangle
            and f.zone_name = d.zone_name
      )
      and not exists (
          select 1 from page p
          where p.tournament_month = d.tournament_month and p.triangle = d.triangle
      )
),

-- The inferred rank is trusted only when no two names in the triangle share it.
inferred as (
    select
        *,
        count(*) over (partition by tournament_month, triangle) as names,
        count(position) over (partition by tournament_month, triangle) as placed,
        count(*) over (partition by tournament_month, triangle, position) as sharing
    from named
),

podium as (
    select
        *,
        count(*) filter (where position is not null and sharing > 1)
            over (partition by tournament_month, triangle) as clashes
    from inferred
),

-- Three names are the top three, so the one missing rank belongs to the one unplaced name.
eliminated as (
    select
        tournament_month,
        triangle,
        zone_name,
        case
            when position is not null and sharing = 1 then position
            when names = 3 and placed = 2 and clashes = 0
                then cast(6 - sum(position) over (partition by tournament_month, triangle) as smallint)
        end as placement,
        case
            when position is not null and sharing = 1 then 'battle-reports'
            when names = 3 and placed = 2 and clashes = 0 then 'elimination'
            else 'unordered'
        end as placement_source,
        names
    from podium
    where position is null or position <= 3
),

candidates as (
    select tournament_month, triangle, zone_name, position as placement, 'page' as placement_source
    from page
    where position <= 3

    union all

    -- A six-name month where the inferred ranks do not fill the podium cannot say which
    -- unplaced name finished third, so those names are dropped rather than guessed.
    select tournament_month, triangle, zone_name, placement, placement_source
    from eliminated
    where names = 3 or placement is not null
),

honored as (
    select
        cast(c.tournament_month - interval '1 month' as date) as tournament_month,
        c.triangle as faction,
        coalesce(al.player_name, c.zone_name) as player_name,
        c.placement,
        c.placement_source
    from candidates c
    left join {{ ref('atlantis_zone_name_aliases') }} al
        on lower(al.zone_name) = lower(c.zone_name)
    -- The first tournament's zones (2014-06) honor no earlier tournament.
    where cast(c.tournament_month - interval '1 month' as date) in (
        select tournament_month from {{ ref('dim_atlantis_tournament_derived') }}
    )
),

-- The final board is the finish itself, so it covers a month before the next month's
-- zones are named. Players tied on launches share a rank and their order is unknown.
board_ranked as (
    select
        p.tournament_month,
        p.faction,
        p.player_name,
        rank() over (partition by p.tournament_month, p.faction order by p.launches desc) as board_rank
    from {{ ref('fct_atlantis_payout') }} p
    join {{ ref('dim_atlantis_tournament') }} t on t.tournament_month = p.tournament_month
    where t.is_finished and not p.is_estimate and p.faction <> 'Unconfirmed'
),

board as (
    select
        tournament_month,
        faction,
        player_name,
        case when count(*) over (partition by tournament_month, faction, board_rank) = 1
            then cast(board_rank as smallint) end as placement,
        'board' as placement_source
    from board_ranked
    where board_rank <= 3
),

sourced as (
    select *, case placement_source when 'page' then 1 when 'board' then 2 else 3 end as priority
    from (select * from honored union all select * from board)
)

-- The page and the board agree wherever both exist; the page is preferred as the game's own
-- record of who was honored.
select tournament_month, faction, player_name, placement, placement_source
from sourced
qualify priority = min(priority) over (partition by tournament_month, faction)
