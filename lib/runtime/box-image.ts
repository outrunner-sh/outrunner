import { createHash } from "node:crypto";

/**
 * The tools every cloud box's image (box/Dockerfile) carries, pinned: the
 * agent passes Claude flags an old one stops at once on, and drives Claude and
 * Codex by their screens and reads their transcripts
 * (runtime-agent/internal/workspace), which change between versions. Bump one
 * with the agent's screens and fixtures checked on that version; the image's
 * tag changes with it (its test says to what), and CI builds that image.
 */
export const BOX_TOOLS = {
  node: "22.23.5",
  claudeCode: "2.1.304",
  codex: "0.162.1",
  gh: "2.102.1",
} as const;

/**
 * The sha256 of each download a box's tools are installed from, by
 * architecture (Debian's names), so an install runs nothing it hasn't checked.
 * Taken from each release's own published sums; bump them with the version:
 *
 *   node    https://nodejs.org/dist/v<node>/SHASUMS256.txt  (node-v<node>-linux-{x64,arm64}.tar.gz)
 *   claude  https://downloads.claude.ai/claude-code-releases/<claudeCode>/manifest.json  (platforms.linux-{x64,arm64}.checksum)
 *   gh      https://github.com/cli/cli/releases/download/v<gh>/gh_<gh>_checksums.txt  (gh_<gh>_linux_{amd64,arm64}.tar.gz)
 *
 * Codex comes from npm at its exact version, checked against the registry's
 * integrity hash by npm itself.
 */
export const BOX_TOOL_SHA256 = {
  node: {
    amd64: "c54118104acc524633b5abe106bbf44a53126ec8b4e5fa105cb92b5d7de8a1a1",
    arm64: "8bd3dc69eee8f3f226315a80d7d1d4faccf217a4c8fae500168ac2e38f3bdba3",
  },
  claudeCode: {
    amd64: "ea0f135784631619a7a409d07322ecec964f9cc4fd377508ed1ba3f141f27912",
    arm64: "c487117526509ab6d2ee6013e14f181faf68d6d6afe6bb0d4b2b4a9feca5ecb3",
  },
  gh: {
    amd64: "77b9e297e94c50336823d0f84de7ef1be60cba704601fa0d98f129f47a94987b",
    arm64: "5019b3cc6e8a03bb4d88600f8dbda2add8e6407705c159b0c63151036e77a1af",
  },
} as const;

/** The build args box/Dockerfile takes, from {@link BOX_TOOLS} and
 *  {@link BOX_TOOL_SHA256}. */
export function boxBuildArgs(): Record<string, string> {
  return {
    NODE_VERSION: BOX_TOOLS.node,
    NODE_SHA256_AMD64: BOX_TOOL_SHA256.node.amd64,
    NODE_SHA256_ARM64: BOX_TOOL_SHA256.node.arm64,
    CLAUDE_CODE_VERSION: BOX_TOOLS.claudeCode,
    CLAUDE_CODE_SHA256_AMD64: BOX_TOOL_SHA256.claudeCode.amd64,
    CLAUDE_CODE_SHA256_ARM64: BOX_TOOL_SHA256.claudeCode.arm64,
    CODEX_VERSION: BOX_TOOLS.codex,
    GH_VERSION: BOX_TOOLS.gh,
    GH_SHA256_AMD64: BOX_TOOL_SHA256.gh.amd64,
    GH_SHA256_ARM64: BOX_TOOL_SHA256.gh.arm64,
  };
}

/** The tag an image of `dockerfile` built with {@link BOX_TOOLS} goes by: a
 *  hash of both, so a different image never reuses a tag. */
export function boxImageTag(dockerfile: string): string {
  return createHash("sha256")
    .update(dockerfile)
    .update("\0")
    .update(JSON.stringify(boxBuildArgs()))
    .digest("hex")
    .slice(0, 12);
}

/** {@link boxImageTag} of box/Dockerfile as committed. Written out rather than
 *  computed, so the app needs no Dockerfile at runtime; its test fails when
 *  the two part. */
export const BOX_IMAGE_TAG = "1a3ded882f6a";

/** Where CI publishes the image, public. */
export const BOX_IMAGE_REPOSITORY = "ghcr.io/outrunner-sh/outrunner-box";
export const BOX_IMAGE = `${BOX_IMAGE_REPOSITORY}:${BOX_IMAGE_TAG}`;

/**
 * A shell check that a box has the image's tools at the image's versions,
 * printing each that isn't and failing; silent and 0 when all are. Run by CI
 * on the image it built, and on every box when it comes up: a box that fails
 * it is on some other image, and is refused rather than patched.
 */
export function boxCheckScript(): string {
  const { node, claudeCode, codex, gh } = BOX_TOOLS;
  return [
    "fail=0",
    `want() { [ "$3" = "$2" ] || { echo "$1 is \${3:-missing}, expected $2"; fail=1; }; }`,
    `want "Claude Code" ${claudeCode} "$(claude --version 2>/dev/null | cut -d' ' -f1)"`,
    // "codex-cli 0.162.1"
    `want Codex ${codex} "$(codex --version 2>/dev/null | awk '{print $NF}')"`,
    // "gh version 2.102.1 (2026-…)"
    `want gh ${gh} "$(gh --version 2>/dev/null | awk 'NR==1{print $3}')"`,
    // "v22.23.5"
    `want Node ${node} "$(node --version 2>/dev/null | cut -c2-)"`,
    `for tool in tmux git git-lfs jq rg npm python3 sudo; do ` +
      `command -v "$tool" >/dev/null || { echo "$tool is missing"; fail=1; }; done`,
    `exit $fail`,
  ].join("\n");
}
