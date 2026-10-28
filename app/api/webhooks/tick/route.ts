import { after, NextResponse } from "next/server";

import { runWebhookTick } from "@/lib/api/webhooks.deps";
import { optionalEnv } from "@/lib/env";
import { bearerMatches } from "@/lib/http/bearer";

/**
 * The API webhooks' clock: the Cloudflare cron calls it with the
 * reconciler's (every 2 minutes, BILLING_CRON_SECRET as a bearer token). It
 * looks at sessions whose turns outlasted the watch right after a send, and
 * tries again deliveries that failed (lib/api/webhooks.deps.ts). Answered
 * at once; the work runs after.
 */
export async function POST(request: Request) {
  const secret = optionalEnv("BILLING_CRON_SECRET");
  if (!secret) return NextResponse.json({ error: "BILLING_CRON_SECRET is not set on this server." }, { status: 503 });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  }
  after(async () => {
    const done = await runWebhookTick().catch((error: unknown) => {
      console.error("Webhooks tick failed", error);
      return null;
    });
    if (done && (done.watched || done.delivered)) console.log("Webhooks tick", done);
  });
  return NextResponse.json({ ticking: true });
}
