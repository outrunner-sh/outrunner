/** The real I/O behind lib/github/followups.ts. */

import {
  claimLoopAct,
  dueFollowUps,
  followUpTimes,
  installationProject,
  linkedSessions,
  postponeFollowUp,
  pruneLoopRecords,
  pullForBranch,
  queueFollowUp,
  releaseLoopAct,
  resetCiTurns,
  settleFollowUp,
  takeFollowUp,
} from "@/lib/db/github-loop";
import { projectLevel } from "@/lib/db/org-access";
import { appSlug, githubAppConfig, installationToken } from "@/lib/github/app";
import { commitCheckRuns, jobLogTail } from "@/lib/github/ci";
import { GitHubConversationError, postIssueComment, readPull, readReview } from "@/lib/github/conversation";
import { flushFollowUps, type FollowUpDeps, MAX_CI_TURNS, waitAndFlush } from "@/lib/github/followups";
import { loopMember } from "@/lib/github/loop.deps";
import { readPullBranches } from "@/lib/github/mentions";
import { wakeAndSend } from "@/lib/slack/research";

async function token(installationId: number): Promise<string> {
  const config = githubAppConfig();
  if (!config) throw new Error("The GitHub App isn't set up here.");
  return installationToken(config, installationId);
}

/** `scope` is the webhook event's, which its follow-ups are queued on; null
 *  for a flush, which queues none (each follow-up keeps its own project,
 *  checked again by projectScope). Said, not left out: a queue without the
 *  event's scope would queue nothing. */
export function followUpDeps(scope: { orgId: string; projectId: string } | null): FollowUpDeps {
  return {
    scope: async () => scope,
    projectScope: installationProject,
    claim: claimLoopAct,
    linkedSessions,
    pullForBranch,
    queue: queueFollowUp,
    release: releaseLoopAct,
    times: followUpTimes,
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
    async review(installationId, repoFullName, number, reviewId) {
      try {
        return await readReview(await token(installationId), repoFullName, number, reviewId);
      } catch (error) {
        // Deleted since. Anything else (a 5xx, a rate limit) is tried again.
        if (error instanceof GitHubConversationError && error.status === 404) return null;
        throw error;
      }
    },
    member: loopMember,
    level: projectLevel,
    wakeAndSend: (ownerId, workspaceId, prompt, from) => wakeAndSend(ownerId, workspaceId, prompt, from),
    humanSpoke: resetCiTurns,
    comment: async (installationId, repoFullName, number, body) =>
      postIssueComment(await token(installationId), repoFullName, number, body),
    async appSlug() {
      const config = githubAppConfig();
      return config ? appSlug(config) : undefined;
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * The webhook's own wait, after its answer, for the follow-ups its event
 * made (lib/github/followups.ts, waitAndFlush). A restart that cuts it short
 * leaves them for the cron's tick (sweepFollowUps).
 */
export async function flushWhenDue(ids: readonly string[]): Promise<void> {
  await waitAndFlush(ids, followUpDeps(null)).catch((error: unknown) => console.error("GitHub follow-ups: flush failed", error));
}

/** The cron's part (app/api/billing/reconcile): follow-ups due that no
 *  webhook's wait sent, and records past their use. How many went. */
export async function sweepFollowUps(): Promise<number> {
  const results = await flushFollowUps(followUpDeps(null));
  await pruneLoopRecords().catch((error: unknown) => console.error("GitHub loop: pruning old records failed", error));
  return [...results.values()].filter((outcome) => outcome === "sent").length;
}

