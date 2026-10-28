import { after, NextResponse } from "next/server";

import { optionalEnv } from "@/lib/env";
import { bearerMatches } from "@/lib/http/bearer";
import { runSessionsTick } from "@/lib/session/tick";

/**
 * The sessions' clock: the Cloudflare cron calls it with the reconciler's
 * (every 2 minutes, BILLING_CRON_SECRET as a bearer token), and it reads what
 * each live session's agent is doing and where its pull request stands
 * (lib/session/tick.ts). Answered at once; the work runs after.
 */
export async function POST(request: Request) {
  const secret = optionalEnv("BILLING_CRON_SECRET");
  if (!secret) return NextResponse.json({ error: "BILLING_CRON_SECRET is not set on this server." }, { status: 503 });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  }
  after(async () => {
    const done = await runSessionsTick().catch((error: unknown) => {
      console.error("Sessions tick failed", error);
      return null;
    });
    if (done && (done.changed || done.pullRequests || done.skipped)) console.log("Sessions tick", done);
  });
  return NextResponse.json({ ticking: true });
}
