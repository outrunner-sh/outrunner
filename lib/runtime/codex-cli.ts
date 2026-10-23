import { BOX_TOOLS } from "@/lib/runtime/box-image";
import { npmInstallGlobal } from "@/lib/runtime/npm-global";

/**
 * The Codex CLI a box installs, pinned: the agent drives Codex by its screen
 * and reads its transcript (runtime-agent/internal/workspace), and a new
 * version can change either. Bump it with the agent's Codex fixtures
 * re-recorded on that version.
 */
export const CODEX_PACKAGE = `@openai/codex@${BOX_TOOLS.codex}`;

/** Install Codex where there is none: npm's global install, which puts
 *  `codex` on the PATH every user has. `sudo` where the installer isn't root.
 *  Grouped, so it chains after `&&` as one step: a failure before it isn't
 *  hidden by the install that follows succeeding. */
export function codexInstallCommand({ sudo }: { sudo: boolean }): string {
  return `{ command -v codex >/dev/null || ${npmInstallGlobal(CODEX_PACKAGE, { sudo })}; }`;
}
