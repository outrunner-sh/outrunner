import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// These connections live in route/components; the repo has no hook renderer.
// Pin their wiring beside the pure chat lifecycle/list tests.
test("a side-chat plan approval cannot rewrite the main chat's recorded mode", () => {
  const source = readFileSync(path.join(process.cwd(), "app/api/workspaces/[id]/plan/route.ts"), "utf8");
  assert.match(source, /if \(!chat && workspace\.mode !== mode\) await recordWorkspaceMode\(workspace\.id, workspace\.ownerId, mode\)/);
});

test("chat-list and side-question errors have a visible switcher alert", () => {
  const source = readFileSync(path.join(process.cwd(), "components/chat-switcher.tsx"), "utf8");
  assert.match(source, /\{\(error \|\| chats\.error\) && \(/);
  assert.match(source, /role="alert"[\s\S]*?\{error \|\| chats\.error\}/);
  assert.match(source, /chats\.reportError\(null\)/);
});
