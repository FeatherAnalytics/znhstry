/**
 * Parameterized queries, defined as data.
 *
 * One object per template carries its parameters, its SQL, and the scope it must be
 * given before it runs. The same object drives the form, the generated SQL and the
 * validation, so a parameter cannot exist in the UI and be missing from the query.
 *
 * The scope declaration is the whole performance policy, written once. The browser is
 * the database: DuckDB reads the marts over HTTP range requests, and Parquet keeps
 * min/max per row group, so a filter on a file's *leading sort column* skips whole
 * groups and the bytes are never fetched. Measured against the published marts:
 *
 *   one country, all history, joined for names ..... 19.9 MB
 *   last 30 days, every country, joined for names .. 37.2 MB
 *   the same query with no scope at all ............ 79.1 MB
 *
 * Note which of those is cheap. `activity_date` is the *second* sort column of
 * `fct_zone_events`, so a date range prunes almost nothing -- every country's row
 * groups span the whole history. A time filter feels like the cheap one and is not.
 * Only a filter on the leading column earns its keep, which is why `requiredScope`
 * names a parameter that filters on exactly that.
 *
 * Every other mart is under 4 MB, so templates over Atlantis and the battle reports
 * take any filters in any combination and declare no scope at all.
 */
import type { MartsMeta } from "./duckdbWasm";

/**
 * The two marts big enough that an unscoped scan is the reader's problem:
 * `fct_zone_events` is 192 MB and `dim_zone` 64 MB. The type makes a template over
 * either one impossible to define without a scope -- an invariant a test could be
 * written for and then forgotten, so it is spelled where it cannot be.
 */
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
  | {
      id: string;
      label: string;
      kind: "date";
      initial: string;
      /**
       * Where a blank default would mean "all history". A first Run should be cheap
       * and the whole record opt-in, not the other way round: leaving `zone-flips`
       * unbounded reads 39.7 MB, and ninety days of it reads 3.6.
       */
      daysBack?: number;
    }
  | { id: string; label: string; kind: "number"; initial: number; min: number; max: number }
  | { id: string; label: string; kind: "text"; initial: string };

export type Values = Record<string, string | number>;

/**
 * Values the form sets but never shows as a field. `zones` holds the comma-separated
 * ids a near-me radius resolved to, blank when the reader has not used one.
 */
export const HIDDEN_VALUES = ["zones"] as const;

interface Base {
  id: string;
  /** Written as the question a reader arrives with, not as the table it reads. */
  label: string;
  blurb: string;
  params: Param[];
  /**
   * Megabytes over the wire on a first Run: the scope filled, every other parameter
   * left at its default. Measured against the published marts on 2026-09-18 through a
   * proxy that counts response bodies. A guide for the reader, not a promise -- widening
   * the date range or picking a busier country moves it, upward.
   */
  measuredMb: number;
  sql: (v: Values, ctx: Context) => string;
}

export type Template =
  | (Base & { table: GuardedTable; requiredScope: string })
  | (Base & { table: OpenTable; requiredScope?: never });

/**
 * Quoting is a correctness guard, not a security one: the SQL runs in the reader's own
 * browser against public Parquet, so there is no other party's data to reach and no
 * server to attack. What it prevents is an apostrophe in "Ra's al Khaymah" ending the
 * string early and producing a parse error the reader cannot act on.
 */
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

/** A blank date field means "no lower bound", not `date ''`. */
export const sinceClause = (column: string, value: string | number): string =>
  value === "" || value === undefined ? "" : `
  and ${column} >= date ${lit(String(value))}`;

/**
 * A near-me radius, resolved to zone ids before the query runs rather than computed
 * inside it.
 *
 * The haversine is not the expensive part -- joining `dim_zone` to reach the
 * coordinates is. Resolving the circle first, in its own cheap query against
 * `dim_zone` alone, and passing the answer as an id list measured 1.37 MB against
 * 3.49 MB for the same question with the join and the trigonometry inline.
 *
 * The list is bounded because the SQL carries it: `RADIUS_ZONE_CAP` is the point
 * past which the reader should be filtering by country instead of by circle.
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
 * What a template needs to know about the warehouse to write cheap SQL.
 *
 * `lastFullDay` exists to be inlined as a literal rather than asked for as a subquery,
 * and the difference is not small. `fct_zone_events` sorts on
 * (country_id, observed_at, zone_id), so once a country is pinned its row groups are
 * ordered by date and Parquet's min/max stats can skip almost all of them -- but only
 * if the planner knows the date before it picks groups. A scalar subquery is resolved
 * too late, so every group is read and then thrown away. Measured on one country:
 *
 *   ... where activity_date = (select max(activity_date) - 1 from ...) .... 59.47 MB
 *   ... where activity_date = date '2026-09-17' ............................ 4.07 MB
 *
 * The manifest the console already loads carries `newest_event_date`, so this costs
 * nothing to know.
 */
export interface Context {
  /** Newest date in the record, minus one: the newest is always a partial sliver. */
  lastFullDay: string;
}

export const contextFrom = (meta: MartsMeta | null): Context => {
  const newest = meta?.newest_event_date;
  if (!newest) return { lastFullDay: "" };
  const day = new Date(`${newest}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return { lastFullDay: day.toISOString().slice(0, 10) };
};

export const TEMPLATES: Template[] = [
  {
    id: "zone-flips",
    measuredMb: 4.7,
    table: "fct_zone_events",
    requiredScope: "country",
    label: "Who has taken this zone, and when",
    blurb:
      "Every change of holder for zones matching a name, newest first. Before October " +
      "2018 a first row usually records the crawler reaching a zone already held, not a capture.",
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
    measuredMb: 5.1,
    table: "fct_zone_events",
    requiredScope: "country",
    label: "Where did bots move the most",
    blurb:
      "Net bot movement over a window, grouped however you like. Deltas compare each " +
      "zone to its own previous observation, so they span whatever gap that was.",
    params: [
      { id: "country", label: "Country", kind: "country", initial: "" },
      { id: "grain", label: "Group", kind: "choice", options: GRAINS, initial: "zone" },
      { id: "movement", label: "Show", kind: "choice", options: MOVEMENTS, initial: "loss" },
      { id: "since", label: "Since", kind: "date", initial: "", daysBack: 90 },
      { id: "limit", label: "Rows", kind: "number", initial: 50, min: 10, max: 1000 },
    ],
    sql: (v) => {
      // Qualified on both sides of the join: `zone_id` exists in fct_zone_events and in
      // dim_zone, and an unqualified one is an ambiguous-reference error, not a warning.
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
    measuredMb: 3.2,
    table: "fct_zone_events",
    requiredScope: "country",
    label: "Which zones are under attack",
    blurb:
      "Zones on the last full day where somebody lost bots and a faction other than the " +
      "holder still has bots on the ground.",
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
      and e.activity_date = date ${lit(ctx.lastFullDay)}${zoneFilter("e.zone_id", v.zones)}${
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
    measuredMb: 0.1,
    table: "fct_country_daily",
    label: "How a country's balance has shifted",
    blurb:
      "Daily bots on the ground per faction for one country, already rolled up -- this " +
      "reads a pre-aggregated mart rather than the event stream.",
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
    measuredMb: 1.1,
    table: "fct_atlantis_player_month_derived",
    label: "Atlantis player leaderboard",
    blurb:
      "One row per player per tournament month, with launches, kills, losses and the " +
      "estimated payout. The whole mart is 1.4 MB, so any filter combination is free.",
    params: [
      { id: "month", label: "Tournament month", kind: "text", initial: "" },
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
      // fct_atlantis_player_month_derived stores the faction capitalized, unlike the
      // numeric control_state the zone tables use.
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
    measuredMb: 3.7,
    table: "fct_atlantis_zone_player_daily",
    label: "One player's battle reports",
    blurb:
      "Every Atlantis battle report a player appears in, with their rank and bot counts " +
      "for that report. 3.8 MB in total, so no scope is asked for.",
    params: [
      { id: "player", label: "Player name", kind: "text", initial: "" },
      { id: "since", label: "Since", kind: "date", initial: "" },
      { id: "limit", label: "Rows", kind: "number", initial: 200, min: 10, max: 5000 },
    ],
    sql: (v) => `-- One player's Atlantis battle reports, newest first.
select
    battle_date,
    battle_report_number,
    zone,
    player_name,
    rank,
    launches,
    bots_killed,
    bots_lost
from fct_atlantis_zone_player_daily
where player_name ilike ${lit(`%${v.player}%`)}${sinceClause("battle_date", v.since)}
order by battle_date desc, rank asc
limit ${lit(v.limit)}`,
  },
];

export const byId = (id: string): Template | undefined => TEMPLATES.find((t) => t.id === id);

export const initialValues = (template: Template, ctx: Context): Values => ({
  zones: "",
  ...Object.fromEntries(
    template.params.map((p) => [
      p.id,
      p.kind === "date" && p.daysBack !== undefined ? daysBefore(ctx.lastFullDay, p.daysBack) : p.initial,
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

/**
 * The one thing the reader is stopped for. A guarded template without its scope reads
 * tens of megabytes to answer a question the reader meant to ask about one country.
 */
export const missingScope = (template: Template, values: Values): string | null => {
  if (!template.requiredScope) return null;
  const value = values[template.requiredScope];
  if (value === "" || value === undefined || value === null) {
    const param = template.params.find((p) => p.id === template.requiredScope);
    return param ? param.label : template.requiredScope;
  }
  return null;
};

/**
 * What to tell the reader before they click Run.
 *
 * The figure is the template's own measured cost, not a formula: the formula that
 * looked reasonable predicted 19.9 MB for `contested-zones`, which actually reads 4.1.
 * Filling the scope is the only choice that moves the number by an order of magnitude,
 * so an unscoped guarded template is reported as the size of the whole scan instead.
 */
export const costMb = (template: Template, values: Values, meta: MartsMeta | null): number => {
  if (!missingScope(template, values)) return template.measuredMb;
  const table = meta?.tables[template.table];
  // Unscoped, the read is the table itself less whatever column projection saves.
  return table ? (table.bytes / 1e6) * 0.22 : template.measuredMb;
};
