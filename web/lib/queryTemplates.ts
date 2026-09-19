/**
 * Parameterized queries, defined as data. One object drives the form, the SQL and the
 * validation.
 *
 * `requiredScope` names the parameter that filters on the file's leading sort column,
 * which is the only filter that skips Parquet row groups. Without it a query reads the
 * whole table.
 */
import type { MartsMeta } from "./duckdbWasm";

/** Big enough that an unscoped scan is the reader's problem. The type forces a scope. */
export type GuardedTable = "fct_zone_events" | "dim_zone";

/** Everything else. Small enough that no filter is required of the reader. */
export type OpenTable =
  | "fct_country_daily"
  | "fct_global_daily"
  | "fct_zone_battles"
  | "stg_battlestats"
  | "fct_atlantis_player_month_derived"
  | "fct_atlantis_zone_player_daily"
  | "fct_atlantis_payout"
  | "stg_atlantis_leaderboard";

export type Choice = { value: string; label: string };

export type Param =
  | { id: string; label: string; kind: "choice"; options: Choice[]; initial: string }
  | { id: string; label: string; kind: "country"; initial: string }
  | { id: string; label: string; kind: "month"; initial: string }
  | {
      id: string;
      label: string;
      kind: "date";
      initial: string;
      /** Blank would mean all history: 39.7 MB against 4.7 for ninety days. */
      daysBack?: number;
    }
  | { id: string; label: string; kind: "number"; initial: number; min: number; max: number }
  | { id: string; label: string; kind: "text"; initial: string };

export type Values = Record<string, string | number>;

/** Set by the form, never shown. `zones` holds the ids a near-me radius resolved to. */
export const HIDDEN_VALUES = ["zones"] as const;

interface Base {
  id: string;
  /** Written as the question a reader arrives with, not as the table it reads. */
  label: string;
  blurb: string;
  params: Param[];
  sql: (v: Values, ctx: Context) => string;
}

export type Template =
  | (Base & { table: GuardedTable; requiredScope: string })
  | (Base & { table: OpenTable; requiredScope?: never });

/** Escapes quotes so an apostrophe in a name cannot end the string early. */
export const lit = (value: string | number): string => {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${value} is not a usable number`);
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
};

/** A bare integer for a `country_id`, or `null` when the reader has not picked one. */
export const asCountryId = (value: string | number): number | null => {
  const n = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isInteger(n) ? n : null;
};

/** Lower bound only. Blank is dropped rather than rendered as `date ''`. */
export const sinceClause = (column: string, since: string | number): string =>
  since === "" || since === undefined ? "" : `
  and ${column} >= date ${lit(String(since))}`;

/**
 * Near-me resolves to zone ids before the query runs. Joining `dim_zone` for the
 * coordinates is the cost, not the haversine: 1.37 MB against 3.49 with the join inline.
 */
export const RADIUS_ZONE_CAP = 5000;

export const zoneFilter = (column: string, value: string | number): string =>
  value === "" || value === undefined ? "" : `
  and ${column} in (${String(value)})`;

/** The resolve step: every zone in one country within `km` of a point. */
export const nearbyZonesSql = (countryId: number, lat: number, lon: number, km: number): string =>
  `select zone_id from dim_zone
where country_id = ${lit(countryId)}
  and 6371.0088 * 2 * asin(sqrt(least(1.0,
      pow(sin(radians(latitude - ${lit(lat)}) / 2), 2)
      + cos(radians(${lit(lat)})) * cos(radians(latitude))
        * pow(sin(radians(longitude - ${lit(lon)}) / 2), 2)))) <= ${lit(km)}
limit ${lit(RADIUS_ZONE_CAP)}`;

/** Which country a pair of coordinates falls in, by nearest zone. */
export const countryAtSql = (lat: number, lon: number): string =>
  `select country_id, country_name from dim_zone
order by 6371.0088 * 2 * asin(sqrt(least(1.0,
    pow(sin(radians(latitude - ${lit(lat)}) / 2), 2)
    + cos(radians(${lit(lat)})) * cos(radians(latitude))
      * pow(sin(radians(longitude - ${lit(lon)}) / 2), 2))))
limit 1`;

const DIRECTIONS: Choice[] = [
  { value: "desc", label: "largest first" },
  { value: "asc", label: "smallest first" },
];

const MOVEMENTS: Choice[] = [
  { value: "gain", label: "gains" },
  { value: "loss", label: "losses" },
];

const GRAINS: Choice[] = [
  { value: "zone", label: "per zone" },
  { value: "region", label: "per region" },
  { value: "country", label: "per country" },
];

const FACTIONS: Choice[] = [
  { value: "0", label: "any faction" },
  { value: "1", label: "Legion" },
  { value: "2", label: "Swarm" },
  { value: "3", label: "Faceless" },
];

/** 0 uncaptured, 1 legion, 2 swarm, 3 faceless. DuckDB lists are 1-based. */
const HOLDER = `['uncaptured', 'legion', 'swarm', 'faceless'][control_state + 1]`;

const ownBots = (prefix = "") =>
  `case ${prefix}control_state ` +
  `when 1 then ${prefix}legion_count ` +
  `when 2 then ${prefix}swarm_count ` +
  `when 3 then ${prefix}faceless_count else 0 end`;

/**
 * Inlined as a literal, never asked for as a subquery: a subquery resolves too late to
 * prune row groups. Same query, 59.47 MB against 4.07.
 */
export interface Context {
  /** Newest date in the record. Usually a partial day; partial is still data. */
  newestDay: string;
}

export const contextFrom = (meta: MartsMeta | null): Context => ({
  newestDay: meta?.newest_event_date ?? "",
});

export const TEMPLATES: Template[] = [
  {
    id: "zone-flips",
    table: "fct_zone_events",
    requiredScope: "country",
    label: "Who has taken this zone, and when",
    blurb: "Who took each zone, and when.",
    params: [
      { id: "country", label: "Country", kind: "country", initial: "" },
      { id: "zone", label: "Zone name contains", kind: "text", initial: "" },
      { id: "since", label: "Since", kind: "date", initial: "", daysBack: 90 },
      { id: "limit", label: "Rows", kind: "number", initial: 200, min: 10, max: 5000 },
    ],
    sql: (v) => `-- Every change of holder, for zones whose name matches.
select
    e.zone_id,
    z.zone_name,
    z.region_name,
    e.observed_at,
    ${HOLDER.replaceAll("control_state", "e.prev_control_state")} as taken_from,
    ${HOLDER.replaceAll("control_state", "e.control_state")} as taken_by,
    ${ownBots("e.")} as bots_held
from fct_zone_events e
join dim_zone z on z.zone_id = e.zone_id
where e.country_id = ${lit(asCountryId(v.country) ?? -1)}
  and z.country_id = ${lit(asCountryId(v.country) ?? -1)}
  and e.is_capture
  and z.zone_name ilike ${lit(`%${v.zone}%`)}${zoneFilter("e.zone_id", v.zones)}${sinceClause("e.activity_date", v.since)}
order by e.observed_at desc
limit ${lit(v.limit)}`,
  },

  {
    id: "biggest-swings",
    table: "fct_zone_events",
    requiredScope: "country",
    label: "Where did bots move the most",
    blurb: "Net bot movement over a window.",
    params: [
      { id: "country", label: "Country", kind: "country", initial: "" },
      { id: "grain", label: "Granularity", kind: "choice", options: GRAINS, initial: "zone" },
      { id: "movement", label: "Show", kind: "choice", options: MOVEMENTS, initial: "loss" },
      { id: "since", label: "Since", kind: "date", initial: "", daysBack: 90 },
      { id: "limit", label: "Rows", kind: "number", initial: 50, min: 10, max: 1000 },
    ],
    sql: (v) => {
      // `zone_id` is in both tables; unqualified is an ambiguous-reference error.
      const grain =
        v.grain === "country"
          ? { key: "z.country_name", select: "z.country_name" }
          : v.grain === "region"
            ? { key: "z.region_name", select: "z.region_name" }
            : { key: "z.zone_name, e.zone_id", select: "z.zone_name, e.zone_id" };
      const direction = v.movement === "gain" ? "desc" : "asc";
      return `-- Net bot movement ${v.movement === "gain" ? "gained" : "lost"}, ${String(v.grain)} level.
select
    ${grain.select},
    sum(e.total_delta) as net_bots,
    sum(e.legion_delta) as legion,
    sum(e.swarm_delta) as swarm,
    sum(e.faceless_delta) as faceless,
    count(*) as observations
from fct_zone_events e
join dim_zone z on z.zone_id = e.zone_id
where e.country_id = ${lit(asCountryId(v.country) ?? -1)}
  and z.country_id = ${lit(asCountryId(v.country) ?? -1)}${zoneFilter("e.zone_id", v.zones)}${sinceClause("e.activity_date", v.since)}
group by ${grain.key}
order by net_bots ${direction}
limit ${lit(v.limit)}`;
    },
  },

  {
    id: "contested-zones",
    table: "fct_zone_events",
    requiredScope: "country",
    label: "Which zones are under attack",
    blurb: "Zones losing bots with an enemy still present.",
    params: [
      { id: "country", label: "Country", kind: "country", initial: "" },
      { id: "holder", label: "Held by", kind: "choice", options: FACTIONS, initial: "0" },
      {
        id: "floor",
        label: "Minimum opposing bots",
        kind: "number",
        initial: 1,
        min: 1,
        max: 10_000_000,
      },
      { id: "limit", label: "Rows", kind: "number", initial: 100, min: 10, max: 1000 },
    ],
    sql: (v, ctx) => {
      const holder = Number(v.holder);
      return `-- Contested zones on the last full day. The newest date is a partial sliver.
with contested as (
    select
        e.zone_id,
        z.zone_name,
        z.region_name,
        ${HOLDER.replaceAll("control_state", "e.control_state")} as holder,
        ${ownBots("e.")} as owning_bots,
        e.total_count - (${ownBots("e.")}) as opposing_bots,
        -least(e.legion_delta, e.swarm_delta, e.faceless_delta) as bots_lost
    from fct_zone_events e
    join dim_zone z on z.zone_id = e.zone_id
    where e.country_id = ${lit(asCountryId(v.country) ?? -1)}
      and z.country_id = ${lit(asCountryId(v.country) ?? -1)}
      and e.activity_date = date ${lit(ctx.newestDay)}${zoneFilter("e.zone_id", v.zones)}${
        holder > 0 ? `\n      and e.control_state = ${lit(holder)}` : ""
      }
)
select * from contested
where bots_lost > 0
  and opposing_bots >= ${lit(v.floor)}
order by opposing_bots desc
limit ${lit(v.limit)}`;
    },
  },

  {
    id: "faction-share",
    table: "fct_country_daily",
    label: "How a country's balance has shifted",
    blurb: "Faction bot counts by country.",
    params: [
      { id: "country", label: "Country", kind: "country", initial: "" },
      { id: "since", label: "Since", kind: "date", initial: "", daysBack: 365 },
      { id: "limit", label: "Rows", kind: "number", initial: 400, min: 10, max: 5000 },
    ],
    sql: (v) => `-- Daily faction balance for one country, from the country rollup.
select
    activity_date,
    legion_bots,
    swarm_bots,
    faceless_bots,
    total_bots,
    round(100.0 * legion_bots / nullif(total_bots, 0), 1) as legion_pct,
    round(100.0 * swarm_bots / nullif(total_bots, 0), 1) as swarm_pct,
    round(100.0 * faceless_bots / nullif(total_bots, 0), 1) as faceless_pct
from fct_country_daily
where country_id = ${lit(asCountryId(v.country) ?? -1)}
${sinceClause("activity_date", v.since)}
order by activity_date desc
limit ${lit(v.limit)}`,
  },

  {
    id: "atlantis-players",
    table: "fct_atlantis_player_month_derived",
    label: "Atlantis player leaderboard",
    blurb: "Players ranked by month.",
    params: [
      { id: "month", label: "Tournament month", kind: "month", initial: "" },
      { id: "faction", label: "Faction", kind: "choice", options: FACTIONS, initial: "0" },
      {
        id: "sort",
        label: "Sort by",
        kind: "choice",
        options: [
          { value: "bots_killed", label: "bots killed" },
          { value: "launches", label: "launches" },
          { value: "bots_lost", label: "bots lost" },
          { value: "qredits_estimate", label: "estimated payout" },
        ],
        initial: "bots_killed",
      },
      { id: "direction", label: "Order", kind: "choice", options: DIRECTIONS, initial: "desc" },
      { id: "limit", label: "Rows", kind: "number", initial: 100, min: 10, max: 2000 },
    ],
    sql: (v) => {
      const faction = Number(v.faction);
      // Capitalized here, unlike the numeric control_state the zone tables use.
      const names = ["", "Legion", "Swarm", "Faceless"];
      return `-- Atlantis players by month. Mercenaries launched for more than one faction.
select
    tournament_month,
    player_name,
    faction,
    is_mercenary,
    launches,
    bots_killed,
    bots_lost,
    rank_in_faction,
    qredits_estimate
from fct_atlantis_player_month_derived
where true${v.month ? `\n  and tournament_month = ${lit(String(v.month))}` : ""}${
        faction > 0 ? `\n  and faction = ${lit(names[faction])}` : ""
      }
order by ${String(v.sort)} ${v.direction === "asc" ? "asc" : "desc"} nulls last
limit ${lit(v.limit)}`;
    },
  },

  {
    id: "player-battles",
    table: "fct_atlantis_zone_player_daily",
    label: "A player's Atlantis activity",
    blurb: "One player's Atlantis record.",
    params: [
      { id: "player", label: "Player name", kind: "text", initial: "" },
      { id: "month", label: "Tournament month", kind: "month", initial: "" },
      {
        id: "shape",
        label: "Show",
        kind: "choice",
        options: [
          { value: "detail", label: "one row per report" },
          { value: "totals", label: "totals per player" },
        ],
        initial: "detail",
      },
      { id: "limit", label: "Rows", kind: "number", initial: 200, min: 10, max: 5000 },
    ],
    sql: (v) => {
      const where =
        `where player_name ilike ${lit(`%${v.player}%`)}` +
        (v.month ? `\n  and tournament_month = ${lit(String(v.month))}` : "");
      if (v.shape === "totals") {
        return `-- One row per player: their whole Atlantis record over the months selected.
select
    player_name,
    count(distinct tournament_month) as months,
    count(*) as reports,
    count(distinct zone) as zones,
    sum(launches) as launches,
    sum(bots_killed) as bots_killed,
    sum(bots_lost) as bots_lost,
    min(battle_date) as first_seen,
    max(battle_date) as last_seen
from fct_atlantis_zone_player_daily
${where}
group by 1
order by bots_killed desc
limit ${lit(v.limit)}`;
      }
      return `-- One row per Atlantis battle report the player appears in, newest first.
select
    battle_date,
    tournament_month,
    zone,
    zone_name,
    player_name,
    faction,
    rank,
    launches,
    bots_killed,
    bots_lost
from fct_atlantis_zone_player_daily
${where}
order by battle_date desc, rank asc
limit ${lit(v.limit)}`;
    },
  },
];

export const byId = (id: string): Template | undefined => TEMPLATES.find((t) => t.id === id);

export const initialValues = (template: Template, ctx: Context): Values => ({
  zones: "",
  ...Object.fromEntries(
    template.params.map((p) => [
      p.id,
      p.kind === "date" && p.daysBack !== undefined ? daysBefore(ctx.newestDay, p.daysBack) : p.initial,
    ]),
  ),
});

/** A date `days` before `from`, or blank when the manifest has not loaded yet. */
export const daysBefore = (from: string, days: number): string => {
  if (!from) return "";
  const day = new Date(`${from}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - days);
  return day.toISOString().slice(0, 10);
};

/** A guarded template without its scope reads tens of megabytes. */
export const missingScope = (template: Template, values: Values): string | null => {
  if (!template.requiredScope) return null;
  const value = values[template.requiredScope];
  if (value === "" || value === undefined || value === null) {
    const param = template.params.find((p) => p.id === template.requiredScope);
    return param ? param.label : template.requiredScope;
  }
  return null;
};

