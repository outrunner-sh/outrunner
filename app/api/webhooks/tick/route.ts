import { NextResponse } from "next/server";

import { after } from "@/lib/observability/after";
import { cronAuth } from "@/lib/cron/auth";
import { runCronJob } from "@/lib/cron/heartbeat.deps";
import { runWebhookTick } from "@/lib/api/webhooks.deps";

/**
 * The API webhooks' clock: the Cloudflare cron calls it with the
 * reconciler's (every 2 minutes, BILLING_CRON_SECRET as a bearer token). It
 * looks at sessions whose turns outlasted the watch right after a send, and
 * tries again deliveries that failed (lib/api/webhooks.deps.ts). Answered
 * at once; the work runs after.
 */
export async function POST(request: Request) {
  const refused = cronAuth(request);
  if (refused) return refused;
  after(() =>
    runCronJob("webhooks", async () => {
      const done = await runWebhookTick();
      if (done.watched || done.delivered) console.log("Webhooks tick", done);
    }),
  );
  return NextResponse.json({ ticking: true });
}
