/**
 * Dispatch the data workflows on a schedule GitHub honors: Cloudflare's.
 *
 * Both workflows keep their own `schedule:` as a fallback, and a doubled run is a no-op
 * in each: the Atlantis gate reads `next_run_at`, the top of the hour after a collection,
 * so a second run in the same hour stops before checkout; the nightly's `plan_slots` asks
 * only for days the history is missing, and "Anything to publish?" skips the rebuild when
 * nothing is new.
 */

interface Env {
  GITHUB_TOKEN: string;
}

// Which workflow each cron line in wrangler.jsonc stands for. The nightly fires at 00:45
// because QONQR writes the slot just after 00:00 UTC; if Dropbox is ever slower than that,
// the run is a green no-op and the workflow's own 02:30 schedule picks the day up.
const WORKFLOW_FOR_CRON: Record<string, string> = {
  "7 * * * *": "atlantis.yml",
  "45 0 * * *": "nightly.yml",
};

const REPO = "FeatherAnalytics/znhstry";

export default {
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const workflow = WORKFLOW_FOR_CRON[event.cron];
    if (workflow === undefined) {
      throw new Error(`no workflow for cron "${event.cron}"`);
    }
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GITHUB_TOKEN}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          // GitHub rejects requests without one.
          "user-agent": "znhstry-atlantis-trigger",
        },
        body: JSON.stringify({ ref: "main" }),
      },
    );
    // No retry: the next firing is the retry, and a doubled run is a no-op either way. The
    // throw is what marks the invocation failed in the Worker's cron log; a logged line
    // alone leaves it green.
    if (response.status !== 204) {
      const body = await response.text();
      console.error(`${workflow} dispatch failed: ${response.status} ${body}`);
      throw new Error(`${workflow} dispatch failed: ${response.status}`);
    }
  },

  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
};
