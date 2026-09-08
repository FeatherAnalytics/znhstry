import { FACTIONS } from "@/components/charts/palette";

export interface AtlantisIndex {
  tournaments: TournamentSummary[];
  all_time: { players: AllTimePlayer[]; factions: Record<string, FactionAllTime> };
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
}

export type AllTimePlayer = [string, string, number, number, number];

export interface FactionAllTime {
  wins: number;
  qredits: number;
}

export interface MonthPayload {
  month: string;
  observations: string[];
  placements: [string, number, number][];
  is_finished: boolean;
  players: Record<string, Record<string, PlayerData>>;
  factions: Record<string, FactionData>;
  zones: Record<string, ZoneData>;
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
  return res.json();
}

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

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${Math.round(n)}`;
}
