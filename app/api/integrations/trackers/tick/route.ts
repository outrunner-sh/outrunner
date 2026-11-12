import { NextResponse } from "next/server";

import { after } from "@/lib/observability/after";
import { cronAuth } from "@/lib/cron/auth";
import { recordHeartbeat, runCronJob } from "@/lib/cron/heartbeat.deps";
import { optionalEnv } from "@/lib/env";
import { runTrackersTick } from "@/lib/trackers/tick";

/**
 * The trackers' clock: the Cloudflare cron calls it with the reconciler's
 * (every 2 minutes, BILLING_CRON_SECRET as a bearer token). It refreshes tokens
 * before they run out, so a webhook never has to wait on one. Answered at once;
 * the work runs after.
 */
export async function POST(request: Request) {
  const refused = cronAuth(request);
  if (refused) return refused;
  // Not set up is the job done: its heartbeat says it ran.
  if (!optionalEnv("LINEAR_CLIENT_ID") && !optionalEnv("JIRA_CLIENT_ID")) {
    after(() => recordHeartbeat("trackers"));
    return NextResponse.json({ skipped: "No tracker is set up." });
  }
  after(() =>
    runCronJob("trackers", async () => {
      const done = await runTrackersTick();
      if (done.refreshed || done.failed || done.relayed || done.webhooks) console.log("Trackers tick", done);
    }),
  );
  return NextResponse.json({ ticking: true });
}
