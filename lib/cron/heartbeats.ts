/**
 * The cron's dead-man's switch: which of its jobs last succeeded when, and
 * which are stale. Pure, so tests read it without a database; the writes and
 * reads are lib/cron/heartbeat.deps.ts.
 */

/** Every job the Cloudflare cron runs (cloudflare/worker.ts `scheduled`). */
export const CRON_JOBS = ["reconcile", "slack", "webhooks", "automations", "sessions", "trackers"] as const;
export type CronJob = (typeof CRON_JOBS)[number];

/** The cron runs every 2 minutes: a job with no success in 10 is stale. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export type HeartbeatRow = {
  job: string;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
};

export type HeartbeatStatus = {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** No success in STALE_AFTER_MS, or never. */
  stale: boolean;
};

/** Each job's status at `now`; a job with no row has never succeeded. */
export function heartbeatStatus(rows: readonly HeartbeatRow[], now: number): Record<CronJob, HeartbeatStatus> {
  const byJob = new Map(rows.map((row) => [row.job, row]));
  return Object.fromEntries(
    CRON_JOBS.map((job) => {
      const row = byJob.get(job);
      const success = row?.last_success_at ? Date.parse(row.last_success_at) : NaN;
      return [
        job,
        {
          lastRunAt: row?.last_run_at ?? null,
          lastSuccessAt: row?.last_success_at ?? null,
          lastError: row?.last_error ?? null,
          lastErrorAt: row?.last_error_at ?? null,
          stale: !Number.isFinite(success) || now - success > STALE_AFTER_MS,
        },
      ];
    }),
  ) as Record<CronJob, HeartbeatStatus>;
}

/** What's kept of an error: its message, bounded. */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
  return text.length > 4000 ? `${text.slice(0, 3997)}...` : text;
}

/** The row to write when a job's run ends: a success (`error` undefined),
 *  or what failed. Only the columns it names are written: a failure leaves the last success
 *  as it was, and a success leaves the last error. */
export function heartbeatWrite(job: CronJob, error: unknown, now: Date): Partial<HeartbeatRow> & { job: CronJob } {
  const at = now.toISOString();
  if (error === undefined) return { job, last_run_at: at, last_success_at: at };
  return { job, last_run_at: at, last_error: errorText(error), last_error_at: at };
}
