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
  node: "22",
  claudeCode: "2.1.304",
  codex: "0.146.0",
  gh: "2.102.1",
} as const;

/** The build args box/Dockerfile takes, from {@link BOX_TOOLS}. */
export function boxBuildArgs(): Record<string, string> {
  return {
    NODE_MAJOR: BOX_TOOLS.node,
    CLAUDE_CODE_VERSION: BOX_TOOLS.claudeCode,
    CODEX_VERSION: BOX_TOOLS.codex,
    GH_VERSION: BOX_TOOLS.gh,
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
export const BOX_IMAGE_TAG = "8381b2257027";

/** Where CI publishes the image, public. */
export const BOX_IMAGE_REPOSITORY = "ghcr.io/neevai-labs/outrunner-box";
export const BOX_IMAGE = `${BOX_IMAGE_REPOSITORY}:${BOX_IMAGE_TAG}`;

/**
 * A shell check that a box has the image's tools at the image's versions,
 * printing each that isn't and failing; silent and 0 when all are. Run by CI
 * on the image it built, and on every box when it comes up: a box that fails
 * it is on some other image, and is refused rather than patched.
 */
export function boxCheckScript(): string {
  const { claudeCode, codex, gh } = BOX_TOOLS;
  return [
    "fail=0",
    `want() { [ "$3" = "$2" ] || { echo "$1 is \${3:-missing}, expected $2"; fail=1; }; }`,
    `want "Claude Code" ${claudeCode} "$(claude --version 2>/dev/null | cut -d' ' -f1)"`,
    // "codex-cli 0.146.0"
    `want Codex ${codex} "$(codex --version 2>/dev/null | awk '{print $NF}')"`,
    // "gh version 2.102.1 (2026-…)"
    `want gh ${gh} "$(gh --version 2>/dev/null | awk 'NR==1{print $3}')"`,
    `for tool in tmux git git-lfs jq rg node npm python3 sudo; do ` +
      `command -v "$tool" >/dev/null || { echo "$tool is missing"; fail=1; }; done`,
    `exit $fail`,
  ].join("\n");
}
