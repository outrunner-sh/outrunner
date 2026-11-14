import { BOX_TOOL_SHA256, BOX_TOOLS } from "@/lib/runtime/box-image";
import { npmInstallGlobal } from "@/lib/runtime/npm-global";

/**
 * The oldest Claude Code a box runs, and the version one older than it is
 * brought up to. The agent passes flags an old Claude stops at once on
 * (Daytona's base image ships 2.1.19, from before --effort) and drives
 * Claude by its screen, which changes between versions. A newer Claude is
 * left alone: a box's own may be. Bump it with the agent's Claude screens
 * (runtime-agent/internal/workspace) checked on that version.
 */
export const CLAUDE_CODE_VERSION = BOX_TOOLS.claudeCode;

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

/** Where Claude Code's native builds are published, by version and platform. */
const CLAUDE_RELEASES = "https://downloads.claude.ai/claude-code-releases";

/**
 * Install Claude Code's native build at {@link CLAUDE_CODE_VERSION} for the
 * user it runs as, as Anthropic's installer (claude.ai/install.sh) does: the
 * binary under ~/.local/share/claude, `claude` linked into ~/.local/bin, where
 * it can keep itself up to date. Unlike piping that installer into bash, the
 * build is checked against its pinned sha256 (BOX_TOOL_SHA256) before it runs,
 * and the version it installed after. glibc Linux, x64 or arm64.
 */
export function claudeNativeInstallCommand(): string {
  const version = CLAUDE_CODE_VERSION;
  const { amd64, arm64 } = BOX_TOOL_SHA256.claudeCode;
  return (
    `case "$(uname -m)" in x86_64|amd64) p=linux-x64 sum=${amd64};; aarch64|arm64) p=linux-arm64 sum=${arm64};; ` +
    `*) echo "No Claude Code build for $(uname -m)"; exit 1;; esac && ` +
    `tmp=$(mktemp -d) && ` +
    `curl -fsSL "${CLAUDE_RELEASES}/${version}/$p/claude" -o "$tmp/claude" && ` +
    `echo "$sum  $tmp/claude" | sha256sum -c --quiet - && ` +
    `chmod 0755 "$tmp/claude" && "$tmp/claude" install ${version} && rm -rf "$tmp" && ` +
    `echo "$sum  $HOME/.local/share/claude/versions/${version}" | sha256sum -c --quiet -`
  );
}
