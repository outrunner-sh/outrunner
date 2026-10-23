import { npmInstallGlobal } from "@/lib/runtime/npm-global";

/**
 * The oldest Claude Code a box runs, and the version one older than it is
 * brought up to. The agent passes flags an old Claude stops at once on
 * (Daytona's base image ships 2.1.19, from before --effort) and drives
 * Claude by its screen, which changes between versions. A newer Claude is
 * left alone: a box's own may be. Bump it with the agent's Claude screens
 * (runtime-agent/internal/workspace) checked on that version.
 */
export const CLAUDE_CODE_VERSION = "2.1.304";

/** Bring a box's Claude Code up to {@link CLAUDE_CODE_VERSION} where it is
 *  missing or older: npm's global install, which puts `claude` on the PATH
 *  every user has. `sudo` where the installer isn't root. Checked again after,
 *  so an older `claude` earlier on the PATH fails the install rather than
 *  every launch. Grouped, so it chains after `&&` as one step. */
export function claudeInstallCommand({ sudo }: { sudo: boolean }): string {
  const pinned = CLAUDE_CODE_VERSION;
  const current = `{ v=$(claude --version 2>/dev/null | cut -d' ' -f1); [ -n "$v" ] && [ "$(printf '%s\\n' ${pinned} "$v" | sort -V | head -n1)" = ${pinned} ]; }`;
  return (
    `{ ${current} || { ${npmInstallGlobal(`@anthropic-ai/claude-code@${pinned}`, { sudo })} && hash -r && ${current}; } || ` +
    `{ echo "Could not bring Claude Code (\${v:-none}) up to ${pinned}"; false; }; }`
  );
}
