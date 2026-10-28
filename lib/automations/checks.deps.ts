/** A run's check on GitHub (lib/automations/checks.ts), as the App. Never
 *  throws: a check is the run's report, never what stops it. */

import {
  CHECK_HOURS,
  closeCheckWithout,
  closeCheckWithReview,
  closedWithout,
  type CheckOutcome,
  type CloseDeps,
  IN_PROGRESS,
  resendReview,
} from "@/lib/automations/checks";
import type { PendingRun } from "@/lib/automations/runs";
import {
  abandonOldChecks,
  checksToSweep,
  checkStateOf,
  claimCheck,
  markCheckClosed,
  markCheckReviewed,
  type OpenCheck,
  recordCheck,
  releaseCheck,
} from "@/lib/db/automation-runs";
import { completeCheckRun, createCheckRun, GitHubAppError, githubAppConfig, installationToken } from "@/lib/github/app";
import { optionalEnv } from "@/lib/env";

/** Where a check's details link: the run's review session, read-only, for
 *  the org's admins. None without a public address. */
function detailsUrl(runId: string): string | undefined {
  const base = optionalEnv("RUNTIME_BASE_URL");
  return base && /^https:\/\//.test(base) ? `${base.replace(/\/+$/, "")}/automations/runs/${runId}` : undefined;
}

/** Open a run's check on its pull request's head, in progress. */
export async function openRunCheck(run: PendingRun): Promise<void> {
  const config = githubAppConfig();
  if (!config) return;
  const { event } = run;
  try {
    const token = await installationToken(config, event.installationId);
    const id = await createCheckRun(token, event.repoFullName, {
      name: run.candidate.name,
      headSha: event.headSha,
      detailsUrl: detailsUrl(run.runId),
      externalId: run.runId,
      output: IN_PROGRESS,
    });
    try {
      await recordCheck(run.runId, id, event.installationId);
    } catch (error) {
      // Not kept, nothing would ever close it: closed now, rather than left
      // in progress for good.
      await completeCheckRun(token, event.repoFullName, id, closedWithout("Outrunner couldn't keep track of this check.")).catch(
        () => {},
      );
      throw error;
    }
  } catch (error) {
    // The App without Checks: Read & write (or the installation not yet
    // accepting it): no check, and nothing else changes.
    if (error instanceof GitHubAppError && error.status === 403) {
      console.warn(`Run ${run.runId}: no check opened; the GitHub App can't write checks on ${event.repoFullName}`);
    } else {
      console.error(`Run ${run.runId}: couldn't open its check`, error);
    }
  }
}

const closeDeps: CloseDeps<OpenCheck> = {
  checkStateOf,
  claimCheck,
  releaseCheck,
  markCheckReviewed,
  markCheckClosed,
  async completeCheck(check, outcome) {
    const config = githubAppConfig();
    if (!config) throw new Error("The GitHub App isn't set up.");
    const token = await installationToken(config, check.installationId);
    await completeCheckRun(token, check.repoFullName, check.checkRunId, outcome);
  },
};

/** Close a run's check without a review, saying why (closeCheckWithout). */
export async function closeRunCheckWithout(runId: string, reason: string): Promise<void> {
  if (!githubAppConfig()) return;
  await closeCheckWithout(runId, reason, closeDeps).catch((error: unknown) =>
    console.error(`Run ${runId}: couldn't close its check`, error),
  );
}

/** Close a run's check with its review, however late (closeCheckWithReview). */
export async function closeRunCheckWithReview(runId: string, outcome: CheckOutcome): Promise<void> {
  if (!githubAppConfig()) return;
  await closeCheckWithReview(runId, outcome, closeDeps).catch((error: unknown) =>
    console.error(`Run ${runId}: couldn't close its check with its review`, error),
  );
}

/** Where a run's check is, for its review's comment to be matched against. */
export async function checkOfRun(runId: string): Promise<OpenCheck | null> {
  return (await checkStateOf(runId))?.check ?? null;
}

/** Close the checks no review came for within CHECK_HOURS, and send again
 *  the reviews GitHub didn't take; how many. The reconciler's cron calls
 *  this. */
export async function sweepOpenChecks(now = new Date()): Promise<number> {
  if (!githubAppConfig()) return 0;
  const before = new Date(now.getTime() - CHECK_HOURS * 3_600_000);
  const retryBefore = new Date(now.getTime() - 2 * 60_000);
  const { stale, unsent } = await checksToSweep(before, retryBefore);
  // Those GitHub hasn't taken in a day won't be: let go of, said so.
  const abandoned = await abandonOldChecks(before, retryBefore);
  if (abandoned > 0) console.warn(`Gave up on ${abandoned} automation run check(s) GitHub wouldn't take for a day`);
  const reason = `No review was posted within ${CHECK_HOURS === 1 ? "an hour" : `${CHECK_HOURS} hours`}.`;
  await Promise.all([
    ...stale.map((runId) => closeRunCheckWithout(runId, reason)),
    ...unsent.map((runId) =>
      resendReview(runId, closeDeps).catch((error: unknown) => console.error(`Run ${runId}: couldn't send its review's check`, error)),
    ),
  ]);
  return stale.length + unsent.length;
}
