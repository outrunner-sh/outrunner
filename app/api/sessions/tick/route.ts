import { NextResponse } from "next/server";

import { purgeExpiredSignIns } from "@/lib/browser-sign-ins/sign-ins.deps";
import { after } from "@/lib/observability/after";
import { cronAuth } from "@/lib/cron/auth";
import { runCronJob } from "@/lib/cron/heartbeat.deps";
import { runMissionTick } from "@/lib/missions/tick";
import { runSessionsTick } from "@/lib/session/tick";

/**
 * The sessions' clock: the Cloudflare cron calls it with the reconciler's
 * (every 2 minutes, BILLING_CRON_SECRET as a bearer token), and it reads what
 * each live session's agent is doing and where its pull request stands, and
 * sends the notifications due by email and Slack (lib/session/tick.ts). Then
 * Missions' part (lib/missions/tick.ts): their Runners' awaited turns, pull
 * requests and deliveries, on what the sessions' reads just recorded.
 * Last, the desktop browser sign-ins past their time are deleted
 * (lib/browser-sign-ins/sign-ins.ts). Answered at once; the work runs after.
 */
export async function POST(request: Request) {
  const refused = cronAuth(request);
  if (refused) return refused;
  after(() =>
    runCronJob("sessions", async () => {
      // The sessions' part failing doesn't keep Missions' from running; the
      // job is still recorded as failed, below.
      let failed: { error: unknown } | null = null;
      const done = await runSessionsTick().catch((error: unknown) => {
        failed = { error };
        return null;
      });
      const delivered = done?.delivered;
      if (done && (done.changed || done.pullRequests || done.skipped || done.failures || delivered?.emailed || delivered?.slacked || delivered?.digests)) console.log("Sessions tick", done);
      const missions = await runMissionTick();
      if (missions.turns || missions.pullRequests || missions.queued || missions.failures || missions.delivered) console.log("Missions tick", missions);
      const expired = await purgeExpiredSignIns().catch((error: unknown) => {
        console.error("Couldn't delete the browser sign-ins past their time", error instanceof Error ? error.message : error);
        return 0;
      });
      if (expired) console.log("Browser sign-ins deleted past their time", { expired });
      if (failed) throw (failed as { error: unknown }).error;
    }),
  );
  return NextResponse.json({ ticking: true });
}
