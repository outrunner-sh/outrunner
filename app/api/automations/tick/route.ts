import { after, NextResponse } from "next/server";

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
import { optionalEnv } from "@/lib/env";
import { appSlug, githubAppConfig } from "@/lib/github/app";
import { bearerMatches } from "@/lib/http/bearer";
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
  const secret = optionalEnv("BILLING_CRON_SECRET");
  if (!secret) return NextResponse.json({ error: "BILLING_CRON_SECRET is not set on this server." }, { status: 503 });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  }
  // A run works on GitHub as the App: without one, nothing is run, and the
  // schedules wait, due, for it.
  const config = githubAppConfig();
  if (!config) return NextResponse.json({ skipped: "The GitHub App isn't set up." });
  try {
    const now = new Date();
    const runs = await planScheduledRuns(now, { dueSchedules, automationCandidates, recordRuns, advanceSchedule });
    // And the runs whose debounce window has passed with no one to start
    // them (a restart cut their wait off).
    const waited = await planQueuedRuns(now, { claimQueuedRuns, claimedCandidates, settleRun }, await appSlug(config));
    after(() => Promise.all([...runs, ...waited].map((run) => startRun(run, startDeps()))));
    return NextResponse.json({ scheduled: runs.length, waited: waited.length });
  } catch (error) {
    // Before its migration there are no schedules to run.
    if (probeStatus(error as { code?: string }) === "missing") return NextResponse.json({ skipped: "No schedules yet." });
    console.error("Automations tick failed", error);
    return NextResponse.json({ error: "The automations tick failed." }, { status: 500 });
  }
}
