/**
 * The environment a user's Runtime Computer boots its agent with.
 *
 * Separate from `ensure-runtime-computer.ts` on purpose: that module takes all
 * its collaborators by injection so it unit-tests without Next or a database,
 * and reading a stored credential here would drag `next/headers` into it
 * through the Supabase server client.
 */

import { getClaudeCredential } from "@/lib/db/credentials";
import { anthropicEnvVar } from "@/lib/runtime/anthropic-env";

/**
 * The Claude credential to boot this user's agent with — their own, never the
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
 * (Settings → Providers). Returns {} when the user has neither; callers fail closed on that rather
 * than falling back to a shared credential.
 */
export async function runtimeSessionEnvironment(
  userId: string,
): Promise<Record<string, string>> {
  const credential = await getClaudeCredential(userId);
  if (!credential) return {};
  return { [anthropicEnvVar(credential)]: credential };
}

export { anthropicEnvVar };
