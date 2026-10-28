/** The real I/O behind lib/github/followups.ts. */

import {
  claimLoopAct,
  dueFollowUps,
  installationProject,
  linkedSessions,
  postponeFollowUp,
  pruneLoopRecords,
  pullForBranch,
  queueFollowUp,
  resetCiTurns,
  settleFollowUp,
  takeFollowUp,
} from "@/lib/db/github-loop";
import { appSlug, githubAppConfig, installationToken } from "@/lib/github/app";
import { commitCheckRuns, jobLogTail } from "@/lib/github/ci";
import { postIssueComment, readPull, readReview } from "@/lib/github/conversation";
import { CI_SETTLE_SECONDS, flushFollowUps, type FollowUpDeps, MAX_CI_TURNS, REVIEW_SETTLE_SECONDS } from "@/lib/github/followups";
import { loopDeps } from "@/lib/github/loop.deps";
import { readPullBranches } from "@/lib/github/mentions";
import { wakeAndSend } from "@/lib/slack/research";

async function token(installationId: number): Promise<string> {
  const config = githubAppConfig();
  if (!config) throw new Error("The GitHub App isn't set up here.");
  return installationToken(config, installationId);
}

export function followUpDeps(): FollowUpDeps {
  const loop = loopDeps();
  return {
    scope: installationProject,
    claim: claimLoopAct,
    linkedSessions,
    pullForBranch,
    queue: queueFollowUp,
    due: dueFollowUps,
    postpone: postponeFollowUp,
    take: (id) => takeFollowUp(id, MAX_CI_TURNS),
    settle: settleFollowUp,
    async pull(installationId, repoFullName, number) {
      const pr = await readPull(await token(installationId), repoFullName, number);
      const branches = readPullBranches(pr as never, repoFullName);
      return branches ? { open: pr.state === "open", headSha: branches.headSha, headRef: branches.headRef } : null;
    },
    checkRuns: async (installationId, repoFullName, sha) => commitCheckRuns(await token(installationId), repoFullName, sha),
    jobLog: async (installationId, repoFullName, jobId) => jobLogTail(await token(installationId), repoFullName, jobId),
    review: async (installationId, repoFullName, number, reviewId) =>
      readReview(await token(installationId), repoFullName, number, reviewId),
    member: loop.member,
    canRead: loop.canRead,
    wakeAndSend: (ownerId, workspaceId, prompt, from) => wakeAndSend(ownerId, workspaceId, prompt, from),
    humanSpoke: resetCiTurns,
    comment: async (installationId, repoFullName, number, body) =>
      postIssueComment(await token(installationId), repoFullName, number, body),
    async appSlug() {
      const config = githubAppConfig();
      return config ? appSlug(config) : undefined;
    },
    now: () => Date.now(),
  };
}

/**
 * Wait out a burst, then send what's due: the webhook's own wait, after its
 * answer. A restart that cuts it short leaves the follow-up for the cron's
 * tick (sweepFollowUps).
 */
export async function flushAfter(seconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, (seconds + 5) * 1000));
  await flushFollowUps(followUpDeps()).catch((error: unknown) => console.error("GitHub follow-ups: flush failed", error));
}

/** The cron's part (app/api/billing/reconcile): follow-ups due that no
 *  webhook's wait sent, and records past their use. How many went. */
export async function sweepFollowUps(): Promise<number> {
  const results = await flushFollowUps(followUpDeps());
  await pruneLoopRecords().catch((error: unknown) => console.error("GitHub loop: pruning old records failed", error));
  return [...results.values()].filter((outcome) => outcome === "sent").length;
}

export { CI_SETTLE_SECONDS, REVIEW_SETTLE_SECONDS };
