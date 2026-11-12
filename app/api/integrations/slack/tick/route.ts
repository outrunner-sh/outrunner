import { NextResponse } from "next/server";

import { after } from "@/lib/observability/after";
import { cronAuth } from "@/lib/cron/auth";
import { recordHeartbeat, runCronJob } from "@/lib/cron/heartbeat.deps";
import { optionalEnv } from "@/lib/env";
import { runTick } from "@/lib/slack/proactive";

/**
 * The Slack agent's clock: the Cloudflare cron calls it with the reconciler's
 * (every 2 minutes, BILLING_CRON_SECRET as a bearer token), and it posts
 * what's due (lib/slack/proactive.ts): digests, nudges, follow-ups. Answered
 * at once; the work runs after.
 */
export async function POST(request: Request) {
  const refused = cronAuth(request);
  if (refused) return refused;
  // Not set up is the job done: its heartbeat says it ran.
  if (!optionalEnv("SLACK_SIGNING_SECRET")) {
    after(() => recordHeartbeat("slack"));
    return NextResponse.json({ skipped: "Slack isn't set up." });
  }
  after(() =>
    runCronJob("slack", async () => {
      const done = await runTick();
      if (done.digests || done.nudges || done.followUps || done.replies) console.log("Slack agent tick", done);
    }),
  );
  return NextResponse.json({ ticking: true });
}
