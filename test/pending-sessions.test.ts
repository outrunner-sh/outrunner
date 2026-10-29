import assert from "node:assert/strict";
import { test } from "node:test";

import type { Workspace } from "@/lib/runtime/types";
import {
  forgetPendingSession,
  PENDING_SESSIONS,
  rememberPendingSession,
} from "@/lib/session/pending-sessions";

/** What is held for `id`, as the hook reads it. */
const held = (id: string) => PENDING_SESSIONS.get()[id];

function workspace(id: string): Workspace {
  return {
    id,
    projectId: "p1",
    ownerId: "u1",
    provider: "daytona",
    agent: "claude",
    model: null,
    mode: "build",
    status: "provisioning",
    phase: null,
    branch: `runtime/${id}`,
    title: "Fix",
    baseBranch: "main",
    worktreePath: "",
    sandboxId: null,
    volumeName: null,
    computerId: null,
    tmuxSession: null,
    agentWorkspaceId: null,
    environmentId: null,
    checkouts: null,
    lastActiveAt: null,
    errorMessage: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  };
}

test("a session just made is held until the sidebar's data has it", () => {
  const w = workspace("w-new");
  rememberPendingSession(w);
  assert.equal(held(w.id), w);
  forgetPendingSession(w.id);
  assert.equal(held(w.id), undefined);
});

test("forgetting one that was never held, or twice, is nothing", () => {
  forgetPendingSession("w-never-held");
  const w = workspace("w-twice");
  rememberPendingSession(w);
  forgetPendingSession(w.id);
  forgetPendingSession(w.id);
  assert.equal(held(w.id), undefined);
});

test("holding one doesn't disturb the others", () => {
  const [a, b] = [workspace("w-a"), workspace("w-b")];
  rememberPendingSession(a);
  rememberPendingSession(b);
  forgetPendingSession(a.id);
  assert.equal(held(b.id), b);
  forgetPendingSession(b.id);
});
