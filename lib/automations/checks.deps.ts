/** A run's check on GitHub (lib/automations/checks.ts), as the App. Never
 *  throws: a check is the run's report, never what stops it. */

import { CHECK_HOURS, closedWithout, type CheckOutcome, IN_PROGRESS } from "@/lib/automations/checks";
import type { PendingRun } from "@/lib/automations/runs";
import { claimCheck, openCheckOf, recordCheck, releaseCheck, staleOpenChecks } from "@/lib/db/automation-runs";
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

/**
 * Close a run's check, once, however it ends. A review completes it even if
 * it was closed already (it came after the hour's sweep): it says what
 * happened, and a completed check can be completed again. A close GitHub
 * didn't take is given back, for the sweep to try again.
 */
export async function closeRunCheck(runId: string, outcome: CheckOutcome, { review = false } = {}): Promise<void> {
  const config = githubAppConfig();
  if (!config) return;
  try {
    const check = await openCheckOf(runId, { evenClosed: review });
    if (!check) return;
    const claimed = await claimCheck(runId);
    if (!claimed && !review) return;
    try {
      const token = await installationToken(config, check.installationId);
      await completeCheckRun(token, check.repoFullName, check.checkRunId, outcome);
    } catch (error) {
      if (claimed) await releaseCheck(runId).catch(() => {});
      throw error;
    }
  } catch (error) {
    console.error(`Run ${runId}: couldn't close its check`, error);
  }
}

/** Close a run's check with its review, however late. */
export function closeRunCheckWithReview(runId: string, outcome: CheckOutcome): Promise<void> {
  return closeRunCheck(runId, outcome, { review: true });
}

/** Close a run's check without a review, saying why. */
export function closeRunCheckWithout(runId: string, reason: string): Promise<void> {
  return closeRunCheck(runId, closedWithout(reason));
}

/** Close the checks no review closed within CHECK_HOURS; how many. The
 *  reconciler's cron calls this. */
export async function sweepOpenChecks(now = new Date()): Promise<number> {
  const stale = await staleOpenChecks(new Date(now.getTime() - CHECK_HOURS * 3_600_000));
  await Promise.all(
    stale.map((runId) => closeRunCheckWithout(runId, `No review was posted within ${CHECK_HOURS === 1 ? "an hour" : `${CHECK_HOURS} hours`}.`)),
  );
  return stale.length;
}
