/**
 * The environment a user's Runtime Computer boots its agent with.
 *
 * Separate from `ensure-runtime-computer.ts` on purpose: that module takes all
 * its collaborators by injection so it unit-tests without Next or a database,
 * and reading a stored credential here would drag `next/headers` into it
 * through the Supabase server client.
 */

import { getClaudeCredential, getGithubIdentity, getGithubToken } from "@/lib/db/credentials";
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
 * `gh pr create` as its orientation tells it to. The box is theirs alone (one
 * per user and project), so it reaches no one else's; the agent masks it in
 * the terminal and points git at it for github.com only. Not for a user who
 * chose the Outrunner App to act for them (lib/github/identity.ts): their
 * box asks for the App's tokens as it goes, and never pushes as them.
 */
export async function runtimeSessionEnvironment(
  userId: string,
): Promise<Record<string, string>> {
  const [credential, githubToken] = await Promise.all([
    getClaudeCredential(userId),
    getGithubIdentity(userId).then((identity) => (identity === "personal" ? getGithubToken(userId) : null)),
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
): (() => Promise<void>) | undefined {
  if (!provider.upgradesAgents) return undefined;
  return async () => provider.upgradeAgent(sandboxId, secret, await runtimeSessionEnvironment(userId));
}
