import assert from "node:assert/strict";
import { test } from "node:test";

import type { LocalRuntime } from "@/hooks/use-local-runtime";
import { localBlocker } from "@/hooks/use-session-location";
import type { LocalStatus } from "@/lib/desktop/local-runtime";

const FOLDER = { state: "ok", folder: { path: "/repo", name: "repo", git: true, branch: "main" } } as const;

function runtime(claude: string | null, claudeLoggedIn: boolean | null): LocalRuntime {
  const status = { agentBundled: true, git: "/bin/git", tmux: "/bin/tmux", claude, claudeLoggedIn, claudeSetup: null };
  return { state: "ready", status: status as unknown as LocalStatus } as LocalRuntime;
}

test("a Codex session on this Mac isn't held back by Claude Code", () => {
  // No Claude Code here at all, and no Outrunner models to fall back on.
  assert.equal(localBlocker(runtime(null, null), FOLDER, false, "codex"), null);
  assert.equal(localBlocker(runtime("/bin/claude", false), FOLDER, false, "codex"), null);
  // A Claude Code session still needs it, and its login.
  assert.notEqual(localBlocker(runtime(null, null), FOLDER, false, "claude"), null);
  assert.match(localBlocker(runtime("/bin/claude", false), FOLDER, false, "claude") ?? "", /Log in to Claude Code/);
  // The folder matters to either.
  assert.match(localBlocker(runtime(null, null), { state: "none" }, false, "codex") ?? "", /Choose a repository/);
});
