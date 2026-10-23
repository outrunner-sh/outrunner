import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BOX_IMAGE, BOX_IMAGE_TAG, BOX_TOOLS, boxBuildArgs, boxCheckScript, boxImageTag } from "@/lib/runtime/box-image";

const dockerfile = readFileSync(join(import.meta.dirname, "../box/Dockerfile"), "utf8");

// The app asks providers for BOX_IMAGE; CI publishes what box/Dockerfile
// builds. A tag left behind would boot boxes on the image before the change.
test("BOX_IMAGE_TAG is the tag of box/Dockerfile with the pinned versions", () => {
  assert.equal(BOX_IMAGE_TAG, boxImageTag(dockerfile), "set BOX_IMAGE_TAG to what boxImageTag gives");
  assert.ok(BOX_IMAGE.endsWith(`:${BOX_IMAGE_TAG}`));
});

test("a different pin or Dockerfile is a different tag", () => {
  assert.notEqual(boxImageTag(`${dockerfile}\n`), BOX_IMAGE_TAG);
});

test("the build args are exactly the ARGs box/Dockerfile takes", () => {
  const args = [...dockerfile.matchAll(/^ARG (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(boxBuildArgs()).sort(), args);
});

/** A box with the given tools on its PATH and nothing else but what the check
 *  itself reads output with. `versions` overrides what claude, codex and gh say. */
function box(tools: string[], versions: Partial<Record<"node" | "claude" | "codex" | "gh", string>> = {}) {
  const bin = mkdtempSync(join(tmpdir(), "box-"));
  for (const util of ["awk", "cut"]) symlinkSync(`/usr/bin/${util}`, join(bin, util));
  const says: Record<string, string> = {
    node: `v${versions.node ?? BOX_TOOLS.node}.11.0`,
    claude: `${versions.claude ?? BOX_TOOLS.claudeCode} (Claude Code)`,
    codex: `codex-cli ${versions.codex ?? BOX_TOOLS.codex}`,
    gh: `gh version ${versions.gh ?? BOX_TOOLS.gh} (2026-10-01)\\nhttps://github.com/cli/cli/releases/latest`,
  };
  for (const tool of tools) {
    writeFileSync(join(bin, tool), `#!/bin/sh\nprintf '${says[tool] ?? ""}\\n'\n`, { mode: 0o755 });
  }
  return spawnSync("/bin/sh", ["-c", boxCheckScript()], { env: { ...process.env, PATH: bin }, encoding: "utf8" });
}

const ALL = ["claude", "codex", "gh", "tmux", "git", "git-lfs", "jq", "rg", "node", "npm", "python3", "sudo"];

test("boxCheckScript passes quietly on a box with every tool at its version", () => {
  const result = box(ALL);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "");
});

// Daytona's own image: an old Claude, and none of what we add.
test("boxCheckScript names every tool that's off, and fails", () => {
  const result = box(
    ALL.filter((tool) => tool !== "tmux" && tool !== "codex"),
    { node: "18", claude: "2.1.19", gh: "2.102.0" },
  );
  assert.equal(result.status, 1);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    `Claude Code is 2.1.19, expected ${BOX_TOOLS.claudeCode}`,
    `Codex is missing, expected ${BOX_TOOLS.codex}`,
    `gh is 2.102.0, expected ${BOX_TOOLS.gh}`,
    `Node is 18, expected ${BOX_TOOLS.node}`,
    "tmux is missing",
  ]);
});

// Exact, not at least: a newer Claude is a box on some other image.
test("boxCheckScript refuses a newer Claude Code too", () => {
  const result = box(ALL, { claude: "2.1.999" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Claude Code is 2\.1\.999, expected/);
});
