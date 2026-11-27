/**
 * Dispatch the data workflows on a schedule GitHub honors: Cloudflare's.
 *
 * Atlantis has no GitHub `schedule:` at all. The Worker reads `state.json` from the public
 * bucket every five minutes and dispatches `atlantis.yml` only when `next_run_at` has
 * passed, so the month between tournaments produces no workflow runs. The workflow keeps
 * its own gate on the same file, which makes a doubled dispatch a no-op.
 *
 * The nightly keeps its own `schedule:` as a fallback. Its `plan_slots` asks only for days
 * the history is missing, but "Collect battle reports" can open the publish gate when new
 * reports arrived, so a doubled nightly republishes in that case — harmless, not a no-op.
 *
 * The player-refresh batch rides the Atlantis cron instead of adding its own: the Workers Free plan allows five cron triggers per account. It has no GitHub fallback, because a doubled batch fetches another 175 profiles rather than doing nothing.
 */

interface Env {
  GITHUB_TOKEN: string;
  DATA_ORIGIN: string;
}

// Must match the cron lines in wrangler.jsonc. Atlantis runs two minutes past each
// five-minute boundary: `next_run_at` is the boundary itself, so a tick on it could land
// a moment early and skip. The nightly fires at 00:45 because QONQR writes the slot just
// after 00:00 UTC; if Dropbox is ever slower than that, the run is a green no-op and the
// workflow's own 02:30 schedule picks the day up.
const ATLANTIS_CRON = "2-59/5 * * * *";
const NIGHTLY_CRON = "45 0 * * *";

// On the Atlantis cron's :07 tick at these UTC hours, also start a player-refresh batch. Six hours apart, clear of the 00:45 nightly.
const PLAYER_REFRESH_HOURS = new Set([3, 9, 15, 21]);
const PLAYER_REFRESH_MINUTE = 7;

const REPO = "FeatherAnalytics/znhstry";

async function dispatch(workflow: string, token: string): Promise<string | null> {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        // GitHub rejects requests without one.
        "user-agent": "znhstry-atlantis-trigger",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );
  if (response.status === 204) return null;
  const body = await response.text();
  console.error(`${workflow} dispatch failed: ${response.status} ${body}`);
  return `${workflow} dispatch failed: ${response.status}`;
}

// The same rule as the workflow's gate. Only a 404 means nothing has ever been collected;
// any other failure is a broken origin and throws, because treating it as a first run
// would scrape the game's server every five minutes for the rest of the month. A 200 with
// no readable `next_run_at` still runs, so a bad state file cannot idle the job until the 1st.
async function atlantisIsDue(origin: string, now: number): Promise<boolean> {
  const url = `${origin}/raw/atlantis/state.json`;
  const response = await fetch(url);
  if (response.status === 404) return true;
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const state = (await response.json().catch(() => null)) as { next_run_at?: string } | null;
  const due = Date.parse(state?.next_run_at ?? "");
  return Number.isNaN(due) || now >= due;
}

function isPlayerRefreshTick(at: Date): boolean {
  return at.getUTCMinutes() === PLAYER_REFRESH_MINUTE && PLAYER_REFRESH_HOURS.has(at.getUTCHours());
}

export default {
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    // Every dispatch is attempted before any failure is raised, so one workflow failing to start never stops the other, and a broken state read never stops the player refresh. No retry: the next firing is the retry. The throw is what marks the invocation failed in the Worker's cron log; a logged line alone leaves it green.
    const workflows: string[] = [];
    const failures: string[] = [];
    if (event.cron === NIGHTLY_CRON) {
      workflows.push("nightly.yml");
    } else if (event.cron === ATLANTIS_CRON) {
      try {
        if (await atlantisIsDue(env.DATA_ORIGIN, event.scheduledTime)) workflows.push("atlantis.yml");
      } catch (error) {
        console.error(error);
        failures.push(String(error));
      }
      if (isPlayerRefreshTick(new Date(event.scheduledTime))) workflows.push("player-refresh.yml");
    } else {
      throw new Error(`no workflow for cron "${event.cron}"`);
    }
    for (const failure of await Promise.all(workflows.map((w) => dispatch(w, env.GITHUB_TOKEN)))) {
      if (failure !== null) failures.push(failure);
    }
    if (failures.length > 0) {
      throw new Error(failures.join("; "));
    }
  },

  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
};
