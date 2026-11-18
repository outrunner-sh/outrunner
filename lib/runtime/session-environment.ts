/**
 * The environment a user's Runtime Computer boots its agent with.
 *
 * Separate from `ensure-runtime-computer.ts` on purpose: that module takes all
 * its collaborators by injection so it unit-tests without Next or a database,
 * and reading a stored credential here would drag `next/headers` into it
 * through the Supabase server client.
 */

import { isReviewSession } from "@/lib/github/identity.deps";
import { getClaudeCredential, getGithubIdentity } from "@/lib/db/credentials";
import { personalCredential } from "@/lib/github/personal";
import { anthropicEnvVar, hasClaudeCredential } from "@/lib/runtime/anthropic-env";

/**
 * The credentials to boot this user's agent with — their own, never the
 * operator's.
 *
 * This used to forward ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN and
 * CODEX_API_KEY straight from the server environment. That cannot survive open
 * sign-up: they land in the box's long-lived environment, and Claude runs there
 * with `--permission-mode bypassPermissions`, so any user could read them out
 * and spend the operator's account. PTY redaction does not help — it masks the
 * terminal display, not a file write or an outbound request.
 *
 * Their Claude subscription token, else their Anthropic API key
 * (Settings → Providers). Without either, callers fail closed
 * ({@link hasClaudeCredential}) rather than falling back to a shared credential.
 *
 * And their GitHub token as GH_TOKEN, so the agent can push its branch and run
 * `gh pr create` as its orientation tells it to: a personal access token
 * they pasted, else their GitHub App user token (8 hours at most; the box's
 * git asks for fresh ones as it goes, app/api/runtime/git-credential), or an
 * old sign-in token where those are
 * still allowed (lib/github/personal.ts). The box is theirs alone (one
 * per user and project), so it reaches no one else's; the agent masks it in
 * the terminal and points git at it for github.com only. Not for a user who
 * chose the Outrunner App to act for them (lib/github/identity.ts): their
 * box asks for the App's tokens as it goes, and never pushes as them.
 */
export async function runtimeSessionEnvironment(
  userId: string,
  /** The session the box is for (null: none yet, a pooled box). An
   *  automation's review session's (review_sessions) never gets its user's
   *  GitHub token, on any boot of its box: it asks for the App's. */
  workspaceId: string | null,
): Promise<Record<string, string>> {
  if (workspaceId && (await isReviewSession(workspaceId))) {
    return withoutGitHubToken(await userEnvironment(userId));
  }
  return userEnvironment(userId);
}

async function userEnvironment(userId: string): Promise<Record<string, string>> {
  const [credential, githubToken] = await Promise.all([
    getClaudeCredential(userId),
    getGithubIdentity(userId).then(async (identity) => {
      if (identity !== "personal") return null;
      // A connection GitHub won't renew boots without one: the box's git
      // asks again as it goes, and is told to reconnect.
      return (
        await personalCredential(userId).catch((error: unknown) => {
          console.warn(`Booting user ${userId}'s box without their GitHub token`, error instanceof Error ? error.message : error);
          return null;
        })
      )?.token ?? null;
    }),
  ]);
  return {
    ...(credential ? { [anthropicEnvVar(credential)]: credential } : {}),
    ...(githubToken ? { GH_TOKEN: githubToken } : {}),
  };
}

export { anthropicEnvVar, hasClaudeCredential };

/**
 * A box's agent upgrade (ComputerRuntimeProvider.upgradeAgent) for a session
 * of `userId`'s, its agent booted again with their environment as it is now;
 * undefined where the provider can't upgrade one in place (jcode).
 */
export function boxUpgrade(
  provider: {
    upgradesAgents: boolean;
    upgradeAgent(sandboxId: string, secret: string, sessionEnv: Record<string, string>): Promise<void>;
  },
  sandboxId: string,
  secret: string,
  userId: string,
  /** The session the box is for: a review session's is booted without its
   *  user's GitHub token (runtimeSessionEnvironment). */
  workspaceId: string | null,
): (() => Promise<void>) | undefined {
  if (!provider.upgradesAgents) return undefined;
  return async () => provider.upgradeAgent(sandboxId, secret, await runtimeSessionEnvironment(userId, workspaceId));
}

/** A box's environment without its user's GitHub token: an automation's
 *  review box, which asks for the App's as it goes. */
export function withoutGitHubToken(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name !== "GH_TOKEN"));
}
