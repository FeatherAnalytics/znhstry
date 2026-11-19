/**
 * Dispatch the data workflows on a schedule GitHub honors: Cloudflare's.
 *
 * The nightly and Atlantis workflows keep their own `schedule:` as a fallback. The Atlantis gate reads
 * `next_run_at`, the next :00 or :30 after a collection, so a second run in the same half
 * hour stops before checkout. The nightly's `plan_slots` asks only for days the history is
 * missing, but "Collect battle reports" can open the publish gate when new reports arrived,
 * so a doubled nightly republishes in that case — harmless, not a no-op.
 *
 * The player-refresh batch rides the Atlantis cron instead of adding its own: the Workers Free plan allows five cron triggers per account. It has no GitHub fallback, because a doubled batch fetches another 175 profiles rather than doing nothing.
 */

interface Env {
  GITHUB_TOKEN: string;
}

// Which workflow each cron line in wrangler.jsonc stands for. The nightly fires at 00:45
// because QONQR writes the slot just after 00:00 UTC; if Dropbox is ever slower than that,
// the run is a green no-op and the workflow's own 02:30 schedule picks the day up.
const WORKFLOW_FOR_CRON: Record<string, string> = {
  "7,37 * * * *": "atlantis.yml",
  "45 0 * * *": "nightly.yml",
};

// On the Atlantis cron's :07 tick at these UTC hours, also start a player-refresh batch. Six hours apart, clear of the 00:45 nightly.
const PLAYER_REFRESH_HOURS = new Set([3, 9, 15, 21]);
const PLAYER_REFRESH_CRON = "7,37 * * * *";

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

function workflowsFor(event: ScheduledEvent): string[] {
  const workflow = WORKFLOW_FOR_CRON[event.cron];
  if (workflow === undefined) {
    throw new Error(`no workflow for cron "${event.cron}"`);
  }
  const at = new Date(event.scheduledTime);
  const refresh =
    event.cron === PLAYER_REFRESH_CRON &&
    at.getUTCMinutes() === 7 &&
    PLAYER_REFRESH_HOURS.has(at.getUTCHours());
  return refresh ? [workflow, "player-refresh.yml"] : [workflow];
}

export default {
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    // Every dispatch is attempted before any failure is raised, so one workflow failing to start never stops the other. No retry: the next firing is the retry. The throw is what marks the invocation failed in the Worker's cron log; a logged line alone leaves it green.
    const failures = (
      await Promise.all(workflowsFor(event).map((w) => dispatch(w, env.GITHUB_TOKEN)))
    ).filter((f): f is string => f !== null);
    if (failures.length > 0) {
      throw new Error(failures.join("; "));
    }
  },

  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
};
