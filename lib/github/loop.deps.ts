/** The real I/O behind lib/github/loop.ts: the database, GitHub as the
 *  installation, and sessions as their owners. */

import { isOwner } from "@/lib/auth/allowlist";
import {
  archiveOnClose,
  claimLoopAct,
  githubMember,
  installationProject,
  linkedSessions,
  linkSession,
  releaseLoopAct,
} from "@/lib/db/github-loop";
import { projectLevel } from "@/lib/db/org-access";
import { optionalEnv } from "@/lib/env";
import { githubAppConfig, installationToken } from "@/lib/github/app";
import { reactToComment, readPull, replyToComment } from "@/lib/github/conversation";
import { archiveClosed, handleMention, type LoopDeps } from "@/lib/github/loop";
import { readPullBranches } from "@/lib/github/mentions";
import { archiveServerSessions, startServerSession } from "@/lib/session/server-session";
import { wakeAndSend, wakeSession } from "@/lib/slack/research";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

async function token(installationId: number): Promise<string> {
  const config = githubAppConfig();
  if (!config) throw new Error("The GitHub App isn't set up here.");
  return installationToken(config, installationId);
}

export function loopDeps(): LoopDeps {
  return {
    scope: installationProject,
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
    archiveServerSessions,
  };
}

/** The events the loop hears (docs/github-app.md lists them for the App). */
export const LOOP_EVENTS: ReadonlySet<string> = new Set(["issue_comment", "pull_request_review_comment", "issues", "pull_request"]);

/** The loop's part of a webhook event, run after GitHub has its answer.
 *  Never throws: what failed is logged. */
export async function runGitHubLoop(event: string, payload: unknown, appSlug: string): Promise<void> {
  const deps = loopDeps();
  try {
    if (event === "issue_comment" || event === "pull_request_review_comment") {
      await handleMention(event, payload, deps, appSlug);
    } else if (event === "issues" || event === "pull_request") {
      await archiveClosed(event, payload, deps);
    }
  } catch (error) {
    console.error(`GitHub loop: ${event} failed`, error);
  }
}
