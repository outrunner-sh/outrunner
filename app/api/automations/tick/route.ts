import { NextResponse } from "next/server";

import { after } from "@/lib/observability/after";
import { cronAuth } from "@/lib/cron/auth";
import { reportError } from "@/lib/observability/report";
import { recordHeartbeat, runCronJob } from "@/lib/cron/heartbeat.deps";
import { planQueuedRuns, planScheduledRuns, startRun } from "@/lib/automations/runs";
import { startDeps } from "@/lib/automations/start-deps";
import {
  advanceSchedule,
  automationCandidates,
  claimedCandidates,
  claimQueuedRuns,
  dueSchedules,
  recordRuns,
  settleRun,
} from "@/lib/db/automation-runs";
import { appSlug, githubAppConfig } from "@/lib/github/app";
import { probeStatus } from "@/lib/supabase/probe";

/**
 * Automations' clock: the Cloudflare cron calls it with the reconciler's
 * (every 2 minutes, BILLING_CRON_SECRET as a bearer token), and it starts
 * the runs of the schedules come due (lib/automations/runs.ts,
 * planScheduledRuns), and of the runs whose debounce window has passed
 * (planQueuedRuns). Each is recorded, or taken, before the answer, once, so
 * a tick sent twice, or late, starts nothing twice; their sessions are set
 * up after it.
 */
export async function POST(request: Request) {
  const refused = cronAuth(request);
  if (refused) return refused;
  // A run works on GitHub as the App: without one, nothing is run, and the
  // schedules wait, due, for it.
  const config = githubAppConfig();
  if (!config) {
    after(() => recordHeartbeat("automations"));
    return NextResponse.json({ skipped: "The GitHub App isn't set up." });
  }
  try {
    const now = new Date();
    const runs = await planScheduledRuns(now, { dueSchedules, automationCandidates, recordRuns, advanceSchedule });
    // And the runs whose debounce window has passed with no one to start
    // them (a restart cut their wait off).
    const waited = await planQueuedRuns(now, { claimQueuedRuns, claimedCandidates, settleRun }, await appSlug(config));
    after(() => runCronJob("automations", () => Promise.all([...runs, ...waited].map((run) => startRun(run, startDeps())))));
    return NextResponse.json({ scheduled: runs.length, waited: waited.length });
  } catch (error) {
    // Before its migration there are no schedules to run.
    if (probeStatus(error as { code?: string }) === "missing") {
      after(() => recordHeartbeat("automations"));
      return NextResponse.json({ skipped: "No schedules yet." });
    }
    console.error("Automations tick failed", error);
    reportError(error, { where: "cron:automations" });
    after(() => recordHeartbeat("automations", error));
    return NextResponse.json({ error: "The automations tick failed." }, { status: 500 });
  }
}
