/**
 * Which variables a cloud session's environment may set. Its own module, with
 * no Node in it, so the page can hold an offer to the same rule the server
 * keeps it to (lib/imports/environment.ts) instead of offering a variable that
 * would be dropped on the way.
 */

/** Variables a session's environment may not set: the agent refuses them
 *  too (runtime-agent/internal/workspace/environment.go, checked against
 *  this list by its tests through agent-protocol.fixtures.json). */
export const RESERVED_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "TMPDIR", "LANG", "TERM", "TMUX", "TMUX_PANE",
  "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL", "OPENAI_API_KEY", "CODEX_HOME", "DISABLE_AUTOUPDATER",
] as const;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Whether a session's environment may set `name`. */
export function settableEnv(name: string): boolean {
  return ENV_NAME.test(name) && !(RESERVED_ENV as readonly string[]).includes(name) && !name.startsWith("RUNTIME_");
}
