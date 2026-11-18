/** Item prices and refresh/recharge yields are the portal's Depot page; bots and energy per launch are the QONQR wiki's Launching page, whose Qredit costs agree with the Depot's. */

export interface Ordnance {
  name: string;
  qredits: number;
}

export const ORDNANCE: Ordnance[] = [
  { name: "Nanomissile", qredits: 1_000 },
  { name: "DPF Core", qredits: 500 },
  { name: "Absorbers", qredits: 2_000 },
  { name: "Crystallizer", qredits: 2_500 },
  { name: "Stealth Chroma", qredits: 2_000 },
  { name: "Amp Fuse", qredits: 10_000 },
  { name: "Galvanizer", qredits: 10_000 },
  { name: "Sync Lock Packet", qredits: 5_000 },
];

export interface Formation {
  name: string;
  bots: number;
  energy: number;
  /** The ordnance one launch consumes; null for the free formations. */
  ordnance: string | null;
}

export const FORMATIONS: Formation[] = [
  { name: "Zone Assault", bots: 1_150, energy: 12, ordnance: null },
  { name: "Seekers", bots: 1_200, energy: 10, ordnance: null },
  { name: "Deflection", bots: 1_250, energy: 8, ordnance: null },
  { name: "Shockwave", bots: 1_450, energy: 25, ordnance: null },
  { name: "Nanomissile", bots: 1_200, energy: 15, ordnance: "Nanomissile" },
  { name: "Plasma Beam", bots: 0, energy: 50, ordnance: "DPF Core" },
  { name: "Absorber", bots: 2_000, energy: 25, ordnance: "Absorbers" },
  { name: "Hardened Lattice", bots: 2_500, energy: 20, ordnance: "Crystallizer" },
  { name: "Divert", bots: 1_750, energy: 33, ordnance: "Stealth Chroma" },
  { name: "Bot Booster", bots: 5_000, energy: 30, ordnance: "Amp Fuse" },
  { name: "Strengthen", bots: 5_000, energy: 30, ordnance: "Galvanizer" },
];

/** One cube makes one Nanobot Refresh, which regenerates this many bots. */
export const BOTS_PER_REFRESH = 5_000;
/** One cube makes this many Energy Recharges. */
export const RECHARGES_PER_CUBE = 4;
export const ENERGY_PER_RECHARGE = 100;

export interface DepotExport {
  exchange_rate: { date: string; qredits_per_cube: number } | null;
  rates_seen: number[];
}

export interface LaunchPlan {
  bots: number;
  energy: number;
  refreshes: number;
  recharges: number;
  refreshCubes: number;
  rechargeCubes: number;
  ordnance: Ordnance | null;
  qredits: number;
}

export function planLaunches(formation: Formation, launches: number): LaunchPlan {
  const bots = formation.bots * launches;
  const energy = formation.energy * launches;
  const refreshes = Math.ceil(bots / BOTS_PER_REFRESH);
  const recharges = Math.ceil(energy / ENERGY_PER_RECHARGE);
  const ordnance = ORDNANCE.find((item) => item.name === formation.ordnance) ?? null;
  return {
    bots,
    energy,
    refreshes,
    recharges,
    refreshCubes: refreshes,
    rechargeCubes: Math.ceil(recharges / RECHARGES_PER_CUBE),
    ordnance,
    qredits: (ordnance?.qredits ?? 0) * launches,
  };
}

export interface CubePack {
  /** Price in cents, so sums stay exact. */
  cents: number;
  /** Cubes received, including the free Cubes a Save The NanoBots pack adds. */
  cubes: number;
  /** Extra Cubes when the buyer holds a subscription. */
  subscriberBonus: number;
}

/** The portal's Market/Cubes page. The pricier twin of a size is the same pack plus a $1.00 Save The NanoBots donation, which adds free Cubes. Coins are a separate currency and left out. */
export const CUBE_PACKS: CubePack[] = [
  { cents: 99, cubes: 1, subscriberBonus: 3 },
  { cents: 299, cubes: 5, subscriberBonus: 7 },
  { cents: 499, cubes: 10, subscriberBonus: 10 },
  { cents: 999, cubes: 25, subscriberBonus: 15 },
  { cents: 1899, cubes: 50, subscriberBonus: 25 },
  { cents: 1999, cubes: 55, subscriberBonus: 25 },
  { cents: 3599, cubes: 100, subscriberBonus: 44 },
  { cents: 3699, cubes: 110, subscriberBonus: 44 },
  { cents: 9999, cubes: 500, subscriberBonus: 0 },
  { cents: 10099, cubes: 550, subscriberBonus: 0 },
];

export const SUBSCRIPTION_CENTS = 4999;
const BULK_THRESHOLD = 5_000;

export interface Purchase {
  cents: number;
  cubes: number;
  /** How many of each pack, keyed by its index in CUBE_PACKS. */
  counts: Map<number, number>;
}

/** The cheapest set of packs that yields at least `need` Cubes. Packs can overshoot, so this minimizes cost over "at least", not "exactly". */
export function cheapestPurchase(need: number, subscriber: boolean): Purchase {
  const sizes = CUBE_PACKS.map((p) => p.cubes + (subscriber ? p.subscriberBonus : 0));
  // The 550 pack is the cheapest per Cube either way, so past a few thousand Cubes the bulk is all 550s and only the remainder needs the search.
  const bulkPack = CUBE_PACKS.length - 1;
  const bulk = Math.max(0, Math.floor((Math.ceil(need) - BULK_THRESHOLD) / sizes[bulkPack]));
  const target = Math.max(0, Math.ceil(need) - bulk * sizes[bulkPack]);
  const cost = new Float64Array(target + 1).fill(Infinity);
  const choice = new Int8Array(target + 1).fill(-1);
  cost[0] = 0;
  for (let n = 1; n <= target; n++) {
    for (let i = 0; i < CUBE_PACKS.length; i++) {
      const candidate = CUBE_PACKS[i].cents + cost[Math.max(0, n - sizes[i])];
      if (candidate < cost[n]) {
        cost[n] = candidate;
        choice[n] = i;
      }
    }
  }
  const counts = new Map<number, number>(bulk ? [[bulkPack, bulk]] : []);
  let cubes = bulk * sizes[bulkPack];
  for (let n = target; n > 0; n = Math.max(0, n - sizes[choice[n]])) {
    counts.set(choice[n], (counts.get(choice[n]) ?? 0) + 1);
    cubes += sizes[choice[n]];
  }
  return { cents: cost[target] + bulk * CUBE_PACKS[bulkPack].cents, cubes, counts };
}
