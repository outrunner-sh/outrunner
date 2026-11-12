import { reportError } from "@/lib/observability/report";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

import { heartbeatStatus, heartbeatWrite, type CronJob, type HeartbeatRow, type HeartbeatStatus } from "./heartbeats";

/**
 * Records a job's run as it ends: a success, or `error`. Never throws: a
 * heartbeat that can't be written (the migration not run yet, a database
 * hiccup) is logged, and the job's own outcome stands.
 */
export async function recordHeartbeat(job: CronJob, error?: unknown): Promise<void> {
  try {
    const { error: failed } = await createSupabaseAdminClient()
      .from("cron_heartbeats")
      .upsert(heartbeatWrite(job, error, new Date()), { onConflict: "job" });
    if (failed && probeStatus(failed) !== "missing") console.error(`Couldn't record the ${job} cron's heartbeat`, failed);
  } catch (failure) {
    console.error(`Couldn't record the ${job} cron's heartbeat`, failure);
  }
}

/**
 * Runs a cron job's work (in after(), or before the answer for the
 * reconciler) and records its heartbeat when it ends. A throw is logged,
 * reported to Sentry, kept as the job's last error, and not thrown on.
 */
export async function runCronJob(job: CronJob, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(`The ${job} cron job failed`, error);
    reportError(error, { where: `cron:${job}` });
    await recordHeartbeat(job, error);
    return;
  }
  await recordHeartbeat(job);
}

/** Every job's heartbeat now, or why it can't be read. */
export async function readHeartbeats(): Promise<Record<CronJob, HeartbeatStatus> | "not migrated" | "unreachable"> {
  try {
    const { data, error } = await createSupabaseAdminClient()
      .from("cron_heartbeats")
      .select("job, last_run_at, last_success_at, last_error, last_error_at");
    if (error) return probeStatus(error) === "missing" ? "not migrated" : "unreachable";
    return heartbeatStatus((data ?? []) as HeartbeatRow[], Date.now());
  } catch {
    return "unreachable";
  }
}
