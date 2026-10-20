/**
 * The Codex CLI a box installs, pinned: the agent drives Codex by its screen
 * and reads its transcript (runtime-agent/internal/workspace), and a new
 * version can change either. Bump it with the agent's Codex fixtures
 * re-recorded on that version.
 */
export const CODEX_PACKAGE = "@openai/codex@0.146.0";

/** Install Codex where there is none: npm's global install, which puts
 *  `codex` on the PATH every user has. `sudo` where the installer isn't root.
 *  Grouped, so it chains after `&&` as one step: a failure before it isn't
 *  hidden by the install that follows succeeding. */
export function codexInstallCommand({ sudo }: { sudo: boolean }): string {
  return `{ command -v codex >/dev/null || ${sudo ? "sudo " : ""}npm install -g ${CODEX_PACKAGE}; }`;
}
