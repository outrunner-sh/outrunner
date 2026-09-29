/**
 * The environment a user's Runtime Computer boots its agent with.
 *
 * Separate from `ensure-runtime-computer.ts` on purpose: that module takes all
 * its collaborators by injection so it unit-tests without Next or a database,
 * and reading a stored credential here would drag `next/headers` into it
 * through the Supabase server client.
 */

import { getAnthropicKey } from "@/lib/db/credentials";

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
 * Returns {} when the user has set no key; callers fail closed on that rather
 * than falling back to a shared credential.
 */
export async function runtimeSessionEnvironment(
  userId: string,
): Promise<Record<string, string>> {
  const credential = await getAnthropicKey(userId);
  if (!credential) return {};
  return { [anthropicEnvVar(credential)]: credential };
}

/**
 * Which variable Claude Code reads a given credential from.
 *
 * The two kinds are not interchangeable. An API key (`sk-ant-api…`) bills API
 * credits and belongs in ANTHROPIC_API_KEY; a Claude Code OAuth token
 * (`sk-ant-oat…`, from `claude setup-token`) draws on the user's Pro/Max
 * subscription and belongs in CLAUDE_CODE_OAUTH_TOKEN. Put a token in the
 * key's variable and Claude fails to authenticate with nothing in the UI to
 * explain why — so the prefix decides, rather than assuming everyone pastes
 * an API key.
 */
export function anthropicEnvVar(credential: string): string {
  return credential.startsWith("sk-ant-oat")
    ? "CLAUDE_CODE_OAUTH_TOKEN"
    : "ANTHROPIC_API_KEY";
}
