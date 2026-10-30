import { BOX_TOOLS } from "@/lib/runtime/box-image";
import { npmInstallGlobal } from "@/lib/runtime/npm-global";

/**
 * The Codex CLI a box installs, pinned: the agent drives Codex by its screen
 * and reads its transcript (runtime-agent/internal/workspace), and a new
 * version can change either. Bump it with the agent's Codex fixtures
 * re-recorded on that version.
 */
export const CODEX_CLI_VERSION = BOX_TOOLS.codex;
export const CODEX_PACKAGE = `@openai/codex@${CODEX_CLI_VERSION}`;

/** Bring missing/older Codex installations up to the tested minimum, including
 * restored computers. Older CLIs can accept the stored login but exit during
 * interactive account bootstrap. Preserve newer versions and verify the actual
 * PATH after installation, so a shadowing old binary fails during setup. */
export function codexInstallCommand({ sudo }: { sudo: boolean }): string {
  const pinned = CODEX_CLI_VERSION;
  const current = `{ v=$(codex --version 2>/dev/null | awk '{print $NF}'); printf '%s\\n' "$v" | grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+$' && [ "$(printf '%s\\n' ${pinned} "$v" | sort -V | head -n1)" = ${pinned} ]; }`;
  return (
    `{ ${current} || { ${npmInstallGlobal(CODEX_PACKAGE, { sudo })} && hash -r && ${current}; } || ` +
    `{ echo "Could not bring Codex (\${v:-none}) up to ${pinned}"; false; }; }`
  );
}
