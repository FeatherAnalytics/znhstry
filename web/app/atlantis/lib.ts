import { FACTIONS } from "@/components/charts/palette";

export interface AtlantisIndex {
  tournaments: TournamentSummary[];
  tournaments_derived?: DerivedTournamentSummary[];
  all_time: {
    players: AllTimePlayer[];
    factions: Record<string, FactionAllTime>;
    players_derived?: AllTimePlayer[];
    factions_derived?: Record<string, FactionAllTime>;
  };
}

export interface TournamentSummary {
  month: string;
  stacking_days: number;
  battle_days: number;
  starts_at: string;
  ends_at: string;
  winner: string | null;
  is_finished: boolean;
  observations: number;
  players: number;
  launches_total: number;
  first_observed_at: string;
  last_observed_at: string;
  placements: [string, number, number][];
  top: Record<string, [string, number]>;
  launches: Record<string, number>;
  kills: Record<string, number>;
  faction_players?: Record<string, number>;
  is_derived_placements?: boolean;
  source?: string;
}

export interface FactionDetail {
  launches: number;
  tournaments: number;
  qredits: number;
}

export interface AllTimePlayer {
  name: string;
  factions: Record<string, FactionDetail>;
  launches: number;
  tournaments: number;
  unattributed: number;
  first_month: string;
  last_month: string;
  qredits: number | null;
  is_mercenary: boolean;
}

export interface FactionAllTime {
  wins: number;
  qredits: number;
  launches?: number;
}

export type PlayerMonthRow = [string, string, number, number, number, number | null, number | null, string];

export async function fetchPlayersDetail(base: string): Promise<Record<string, PlayerMonthRow[]>> {
  const res = await fetch(`${base}/atlantis/players.json.br`);
  if (!res.ok) throw new Error(`players: ${res.status}`);
  return res.json();
}

export interface MonthPayload {
  month: string;
  observations: string[];
  placements: [string, number, number][];
  is_finished: boolean;
  players: Record<string, Record<string, PlayerData>>;
  factions: Record<string, FactionData>;
  zones: Record<string, ZoneData>;
  battles?: Record<string, Record<string, [string, number, number, number][]>>;
  source?: string;
}

export interface PlayerData {
  launches: (number | null)[];
  tm: (boolean | null)[];
  wm: (boolean | null)[];
  qredits?: number;
}

export interface FactionData {
  launches_gained: (number | null)[];
  active_players: (number | null)[];
  players_on_board: (number | null)[];
  launches_total: (number | null)[];
}

export interface ZoneData {
  name: string;
  cubes_allowed: boolean;
  swarm: (number | null)[];
  legion: (number | null)[];
  faceless: (number | null)[];
}

export interface Interval {
  index: number;
  prevIndex: number;
  gained: number;
  minutes: number;
  perHour: number;
}

export async function fetchIndex(base: string): Promise<AtlantisIndex> {
  const res = await fetch(`${base}/atlantis/index.json.br`);
  if (!res.ok) throw new Error(`index: ${res.status}`);
  return normalizeIndex(await res.json());
}

// The site and the data deploy separately: a merge redeploys the page at once while the
// bucket keeps the previous nightly's index.json until 00:45 UTC. Everything this release
// added must therefore be optional at the boundary, or one evening a year the page crashes.
function normalizeIndex(raw: AtlantisIndex): AtlantisIndex {
  const withMaps = <T extends { launches?: Record<string, number>; kills?: Record<string, number> }>(t: T): T => ({
    ...t, launches: t.launches ?? {}, kills: t.kills ?? {},
  });
  const isPlayer = (p: unknown): p is AllTimePlayer =>
    typeof p === "object" && p !== null && !Array.isArray(p) && typeof (p as AllTimePlayer).name === "string";
  // JSON never carries undefined, so spreading the entry over the defaults fills only
  // the keys an older export left out.
  const playerDefaults: Omit<AllTimePlayer, "name"> = {
    factions: {}, launches: 0, tournaments: 0, unattributed: 0,
    first_month: "", last_month: "", qredits: null, is_mercenary: false,
  };
  const normalizePlayer = (p: AllTimePlayer): AllTimePlayer => ({ ...playerDefaults, ...p });
  const players = (list: unknown): AllTimePlayer[] =>
    Array.isArray(list) ? list.filter(isPlayer).map(normalizePlayer) : [];
  const allTime = raw.all_time ?? { players: [], factions: {} };
  return {
    tournaments: (raw.tournaments ?? []).map(withMaps),
    tournaments_derived: (raw.tournaments_derived ?? []).map(withMaps),
    all_time: {
      players: players(allTime.players),
      factions: allTime.factions ?? {},
      players_derived: allTime.players_derived ? players(allTime.players_derived) : undefined,
      factions_derived: allTime.factions_derived,
    },
  };
}

export const STALE_DATA_NOTICE = "Data is updating; the newest export publishes overnight.";

export async function fetchMonth(base: string, month: string): Promise<MonthPayload> {
  const res = await fetch(`${base}/atlantis/${month}.json.br`);
  if (!res.ok) throw new Error(`${month}: ${res.status}`);
  return res.json();
}

export function parseObsTimestamps(observations: string[]): number[] {
  return observations.map((iso) => new Date(iso).getTime() / 1000);
}

export function deriveIntervals(values: (number | null)[], obsTs: number[]): Interval[] {
  const result: Interval[] = [];
  let prevIdx = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === null) continue;
    if (prevIdx >= 0) {
      const gained = values[i]! - values[prevIdx]!;
      const minutes = (obsTs[i] - obsTs[prevIdx]) / 60;
      result.push({
        index: i,
        prevIndex: prevIdx,
        gained,
        minutes,
        perHour: minutes > 0 ? (gained / minutes) * 60 : 0,
      });
    }
    prevIdx = i;
  }
  return result;
}

const utcDateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

export function formatObs(ts: number): string {
  return utcDateFmt.format(new Date(ts * 1000)) + " UTC";
}

const utcFullDateFmt = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function formatDate(iso: string): string {
  return utcFullDateFmt.format(new Date(iso)) + " UTC";
}

const utcDateTimeFmt = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function formatDateTime(iso: string): string {
  return utcDateTimeFmt.format(new Date(iso)).replace(",", "") + " UTC";
}

const colorMap: Record<string, string> = { Legion: "var(--legion)", Swarm: "var(--swarm)", Faceless: "var(--faceless)" };
export function factionColor(faction: string): string {
  return colorMap[faction] ?? "var(--text-dim)";
}

const hexMap = Object.fromEntries(FACTIONS.map((f) => [f.label, f.hex]));
export function factionHex(faction: string): string {
  return hexMap[faction] ?? "#7c8798";
}

export function holderOf(zone: ZoneData, idx: number): string | null {
  const counts: [string, number][] = [
    ["Legion", zone.legion[idx] ?? 0],
    ["Swarm", zone.swarm[idx] ?? 0],
    ["Faceless", zone.faceless[idx] ?? 0],
  ];
  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > 0 ? best[0] : null;
}

export function computePerHourRates(
  raw: (number | null)[],
  obsTs: number[],
): (number | null)[] {
  const result: (number | null)[] = new Array(raw.length).fill(null);
  let prevIdx = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === null) continue;
    if (prevIdx >= 0) {
      const minutes = (obsTs[i] - obsTs[prevIdx]) / 60;
      result[i] = minutes > 0 ? (raw[i]! / minutes) * 60 : 0;
    }
    prevIdx = i;
  }
  return result;
}

export const FACTION_ORDER = ["Legion", "Swarm", "Faceless"] as const;

export interface DerivedTournamentSummary {
  month: string;
  source: "reports";
  has_board: boolean;
  stacking_days: number;
  battle_days: number;
  starts_at: string;
  ends_at: string;
  end_tolerance_days: number;
  placement_tiebreak: string | null;
  schedule_note: string | null;
  zone_count: number;
  winner: string | null;
  reports: number;
  players: number;
  launches_total: number;
  first_report_date: string;
  last_report_date: string;
  placements: [string, number, number][];
  top: Record<string, [string, number]>;
  launches: Record<string, number>;
  kills: Record<string, number>;
  faction_players?: Record<string, number>;
}

export interface DerivedZone {
  name: string;
  triangle: string;
  position: number | null;
  legion: number;
  swarm: number;
  faceless: number;
  holder: string | null;
}

export interface DerivedPlayerData {
  launches: number;
  bots_killed: number;
  bots_lost: number;
  reports: number;
  faction_source: string;
  is_mercenary: boolean;
  qredits_estimate: number | null;
}

export interface DerivedMonthPayload {
  month: string;
  source: "reports";
  placements: [string, number, number][];
  zones: DerivedZone[];
  players: Record<string, Record<string, DerivedPlayerData>>;
}

export type AnyTournament = (TournamentSummary & { source?: string }) | DerivedTournamentSummary;

export function mergedTournaments(index: AtlantisIndex): AnyTournament[] {
  const board: AnyTournament[] = index.tournaments.map((t) => ({ ...t }));
  const derived: AnyTournament[] = index.tournaments_derived ?? [];
  const boardMonths = new Set(board.map((t) => t.month));
  const all = [...board, ...derived.filter((d) => !boardMonths.has(d.month))];
  return all.sort((a, b) => a.month.localeCompare(b.month));
}

export function isDerived(t: AnyTournament): t is DerivedTournamentSummary {
  return t.source === "reports";
}

export async function fetchDerivedMonth(base: string, month: string): Promise<DerivedMonthPayload> {
  const res = await fetch(`${base}/atlantis/${month}.json.br`);
  if (!res.ok) throw new Error(`${month}: ${res.status}`);
  return res.json();
}

export function compact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${Math.round(n)}`;
}
