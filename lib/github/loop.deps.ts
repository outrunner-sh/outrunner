/** The real I/O behind lib/github/loop.ts: the database, GitHub as the
 *  installation, and sessions as their owners. */

import { isOwner } from "@/lib/auth/allowlist";
import {
  archiveOnClose,
  claimLoopAct,
  resetCiTurns,
  githubMember,
  installationProject,
  installationProjects,
  linkedSessions,
  linkSession,
  releaseLoopAct,
} from "@/lib/db/github-loop";
import { projectLevel } from "@/lib/db/org-access";
import { optionalEnv } from "@/lib/env";
import { githubAppConfig, installationToken } from "@/lib/github/app";
import { reactToComment, readPull, replyToComment } from "@/lib/github/conversation";
import { queueCiFailure, queueReview } from "@/lib/github/followups";
import { archiveClosed, handleMention, type LoopDeps } from "@/lib/github/loop";
import { readPullBranches } from "@/lib/github/mentions";
import { archiveServerSessions, startServerSession } from "@/lib/session/server-session";
import { suspendSession, wakeAndSend, wakeSession } from "@/lib/slack/research";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

async function token(installationId: number): Promise<string> {
  const config = githubAppConfig();
  if (!config) throw new Error("The GitHub App isn't set up here.");
  return installationToken(config, installationId);
}

export function loopDeps(scope?: { orgId: string; projectId: string }): LoopDeps {
  return {
    scope: scope ? async () => scope : installationProject,
    claim: claimLoopAct,
    release: releaseLoopAct,
    async member(githubUserId, orgId) {
      const userId = await githubMember(githubUserId, orgId);
      if (!userId) return null;
      // As the Slack agent's: someone the deployment no longer lets in
      // steers nothing.
      const { data, error } = await createSupabaseAdminClient().auth.admin.getUserById(userId);
      return !error && data.user && isOwner(data.user) ? userId : null;
    },
    level: projectLevel,
    linkedSessions,
    async pullBranches(installationId, repoFullName, number) {
      try {
        return readPullBranches((await readPull(await token(installationId), repoFullName, number)) as never, repoFullName);
      } catch (error) {
        console.error(`GitHub: couldn't read ${repoFullName}#${number}`, error);
        return null;
      }
    },
    wakeAndSend: (ownerId, workspaceId, prompt) => wakeAndSend(ownerId, workspaceId, prompt, "github"),
    startServerSession,
    link: linkSession,
    async react(installationId, repoFullName, comment) {
      await reactToComment(await token(installationId), repoFullName, comment, "eyes");
    },
    async reply(installationId, repoFullName, mention, body) {
      await replyToComment(await token(installationId), repoFullName, mention.number, mention.comment, body);
    },
    sessionUrl(workspaceId) {
      const base = optionalEnv("RUNTIME_BASE_URL") ?? "";
      return `${base.replace(/\/$/, "")}/workspaces/${workspaceId}`;
    },
    archiveOnClose,
    wake: wakeSession,
    suspend: suspendSession,
    archiveServerSessions,
    humanSpoke: resetCiTurns,
  };
}

/** The events the loop hears (docs/github-app.md lists them for the App). */
export const LOOP_EVENTS: ReadonlySet<string> = new Set([
  "issue_comment",
  "pull_request_review_comment",
  "issues",
  "pull_request",
  "pull_request_review",
  "check_suite",
  "check_run",
  "workflow_run",
]);

/** The loop's part of a webhook event, run after GitHub has its answer.
 *  Never throws: what failed is logged. */
export async function runGitHubLoop(event: string, payload: unknown, appSlug: string): Promise<void> {
  const p = payload as { installation?: { id?: number }; repository?: { full_name?: string } };
  if (!p?.installation?.id || !p.repository?.full_name) return;
  try {
    const scopes = await installationProjects(p.installation.id, p.repository.full_name);
    await Promise.all(scopes.map(async (scope) => {
      try {
        await runScopedLoop(event, payload, appSlug, scope, scopes.length > 1);
      } catch (error) {
        console.error(`GitHub loop: ${event} for org ${scope.orgId} failed`, error);
      }
    }));
  } catch (error) {
    console.error(`GitHub loop: ${event} failed`, error);
  }
}

async function runScopedLoop(
  event: string,
  payload: unknown,
  appSlug: string,
  scope: { orgId: string; projectId: string },
  shared: boolean,
): Promise<void> {
  const deps = { ...loopDeps(scope), quietDenials: shared };
  if (event === "issue_comment" || event === "pull_request_review_comment") {
    await handleMention(event, payload, deps, appSlug);
  } else if (event === "issues" || event === "pull_request") {
    await archiveClosed(event, payload, deps);
  } else if (event === "pull_request_review") {
    // A review joins its pull request's batch, sent once reviews stop
    // coming (lib/github/followups.ts). The review that began the batch
    // waits for it; the others only put it later.
    const { followUpDeps, flushWhenDue } = await import("@/lib/github/followups.deps");
    const batch = await queueReview(event, payload, followUpDeps(scope));
    if (batch) await flushWhenDue([batch]);
  } else if (event === "check_suite" || event === "check_run" || event === "workflow_run") {
    // CI failing: one turn per commit, once its burst of events is over.
    // The burst's first event waits for it; the others only put it later.
    const { followUpDeps, flushWhenDue } = await import("@/lib/github/followups.deps");
    const made = await queueCiFailure(event, payload, followUpDeps(scope), appSlug);
    if (made.length) await flushWhenDue(made);
  }
}
