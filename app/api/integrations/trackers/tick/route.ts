import { after, NextResponse } from "next/server";

import { optionalEnv } from "@/lib/env";
import { bearerMatches } from "@/lib/http/bearer";
import { runTrackersTick } from "@/lib/trackers/tick";

/**
 * The trackers' clock: the Cloudflare cron calls it with the reconciler's
 * (every 2 minutes, BILLING_CRON_SECRET as a bearer token). It refreshes tokens
 * before they run out, so a webhook never has to wait on one. Answered at once;
 * the work runs after.
 */
export async function POST(request: Request) {
  const secret = optionalEnv("BILLING_CRON_SECRET");
  if (!secret) return NextResponse.json({ error: "BILLING_CRON_SECRET is not set on this server." }, { status: 503 });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  }
  if (!optionalEnv("LINEAR_CLIENT_ID") && !optionalEnv("JIRA_CLIENT_ID")) return NextResponse.json({ skipped: "No tracker is set up." });
  after(async () => {
    const done = await runTrackersTick();
    if (done.refreshed || done.failed || done.relayed || done.webhooks) console.log("Trackers tick", done);
  });
  return NextResponse.json({ ticking: true });
}
