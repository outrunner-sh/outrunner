import { after, NextResponse } from "next/server";

import { optionalEnv } from "@/lib/env";
import { bearerMatches } from "@/lib/http/bearer";
import { runMissionTick } from "@/lib/missions/tick";
import { runTick } from "@/lib/slack/proactive";

/**
 * The Slack agent's clock: the Cloudflare cron calls it with the reconciler's
 * (every 2 minutes, BILLING_CRON_SECRET as a bearer token), and it posts
 * what's due (lib/slack/proactive.ts): digests, nudges, follow-ups. Answered
 * at once; the work runs after.
 */
export async function POST(request: Request) {
  const secret = optionalEnv("BILLING_CRON_SECRET");
  if (!secret) return NextResponse.json({ error: "BILLING_CRON_SECRET is not set on this server." }, { status: 503 });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  }
  // Missions' turns, pull requests and deliveries (lib/missions/tick.ts) ride
  // the same clock, with or without Slack.
  after(async () => {
    const done = await runMissionTick();
    if (done.turns || done.pullRequests || done.queued || done.delivered) console.log("Missions tick", done);
  });
  if (!optionalEnv("SLACK_SIGNING_SECRET")) return NextResponse.json({ skipped: "Slack isn't set up." });
  after(async () => {
    const done = await runTick();
    if (done.digests || done.nudges || done.followUps || done.replies) console.log("Slack agent tick", done);
  });
  return NextResponse.json({ ticking: true });
}
