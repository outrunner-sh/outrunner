import { after, NextResponse } from "next/server";

import { planScheduledRuns, startRun } from "@/lib/automations/runs";
import { startDeps } from "@/lib/automations/start-deps";
import { advanceSchedule, automationCandidates, dueSchedules, recordRuns } from "@/lib/db/automation-runs";
import { optionalEnv } from "@/lib/env";
import { githubAppConfig } from "@/lib/github/app";
import { bearerMatches } from "@/lib/http/bearer";
import { probeStatus } from "@/lib/supabase/probe";

/**
 * Automations' clock: the Cloudflare cron calls it with the reconciler's
 * (every 2 minutes, BILLING_CRON_SECRET as a bearer token), and it starts
 * the runs of the schedules come due (lib/automations/runs.ts,
 * planScheduledRuns). Each is recorded before the answer, once per
 * automation, repository and scheduled time, so a tick sent twice, or late,
 * starts nothing twice; their sessions are set up after it.
 */
export async function POST(request: Request) {
  const secret = optionalEnv("BILLING_CRON_SECRET");
  if (!secret) return NextResponse.json({ error: "BILLING_CRON_SECRET is not set on this server." }, { status: 503 });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  }
  // A run works on GitHub as the App: without one, nothing is run, and the
  // schedules wait, due, for it.
  if (!githubAppConfig()) return NextResponse.json({ skipped: "The GitHub App isn't set up." });
  try {
    const runs = await planScheduledRuns(new Date(), { dueSchedules, automationCandidates, recordRuns, advanceSchedule });
    after(() => Promise.all(runs.map((run) => startRun(run, startDeps()))));
    return NextResponse.json({ scheduled: runs.length });
  } catch (error) {
    // Before its migration there are no schedules to run.
    if (probeStatus(error as { code?: string }) === "missing") return NextResponse.json({ skipped: "No schedules yet." });
    console.error("Automations tick failed", error);
    return NextResponse.json({ error: "The automations tick failed." }, { status: 500 });
  }
}
