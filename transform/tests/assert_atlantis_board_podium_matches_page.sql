-- Where a month has both a final board and the next month's named zones, the board's
-- top three by launches must be the players the zones honor, in the same order.
with board as (
    select
        p.tournament_month,
        p.faction,
        p.player_name,
        rank() over (partition by p.tournament_month, p.faction order by p.launches desc) as board_rank
    from {{ ref('fct_atlantis_payout') }} p
    join {{ ref('dim_atlantis_tournament') }} t on t.tournament_month = p.tournament_month
    where t.is_finished and not p.is_estimate and p.faction <> 'Unconfirmed'
),

page as (
    select
        cast(z.tournament_month - interval '1 month' as date) as tournament_month,
        split_part(z.zone, ' ', 1) as faction,
        cast(split_part(z.zone, ' ', 2) as integer) as position,
        coalesce(al.player_name, z.zone_name) as player_name
    from {{ ref('stg_atlantis_zone_months') }} z
    left join {{ ref('atlantis_zone_name_aliases') }} al on lower(al.zone_name) = lower(z.zone_name)
    where regexp_full_match(z.zone, '(Legion|Swarm|Faceless) [123]')
)

select pg.*, b.board_rank
from page pg
join (select distinct tournament_month from board) m using (tournament_month)
left join board b
    on  b.tournament_month = pg.tournament_month
    and b.faction = pg.faction
    and lower(b.player_name) = lower(pg.player_name)
where b.board_rank is null or b.board_rank <> pg.position
