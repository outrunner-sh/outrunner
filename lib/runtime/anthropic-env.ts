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
 *
 * Its own module, with no imports: `session-environment.ts` reaches the
 * credential store, which pulls `next/headers` through the Supabase server
 * client, and the unit-test loader cannot resolve that. A pure decision worth
 * pinning in tests should not be reachable only through a module that needs a
 * Next request context.
 */
export function anthropicEnvVar(credential: string): string {
  return credential.startsWith("sk-ant-oat")
    ? "CLAUDE_CODE_OAUTH_TOKEN"
    : "ANTHROPIC_API_KEY";
}

/**
 * Whether a box environment carries a Claude credential. The environment holds
 * more than Claude's (GH_TOKEN too), so "is it empty" no longer answers this.
 */
export function hasClaudeCredential(env: Record<string, string>): boolean {
  return Boolean(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY);
}
