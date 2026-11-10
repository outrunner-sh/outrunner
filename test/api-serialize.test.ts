import assert from "node:assert/strict";
import { test } from "node:test";

import { API_STATUSES, apiStatus, environmentDetailJson, statusesFor, topLevelCamel, workspaceJson } from "@/lib/api/serialize";
import type { Workspace } from "@/lib/runtime/types";

test("a session's status in the API's words", () => {
  assert.equal(apiStatus("creating"), "preparing");
  assert.equal(apiStatus("provisioning"), "preparing");
  assert.equal(apiStatus("idle"), "ready");
  assert.equal(apiStatus("destroyed"), "deleted");
  assert.deepEqual(statusesFor("preparing").sort(), ["creating", "provisioning"]);
  assert.deepEqual(statusesFor("ready").sort(), ["idle", "ready"]);
  assert.ok(API_STATUSES.includes("archived"));
});

test("a session as the API shows it", () => {
  const workspace: Workspace = {
    id: "w1",
    projectId: "p1",
    orgId: "o1",
    ownerId: "u1",
    source: "api",
    provider: "daytona",
    status: "provisioning",
    phase: "clone",
    branch: "runtime/x",
    title: "Fix it",
    baseBranch: "main",
    worktreePath: "",
    sandboxId: null,
    volumeName: null,
    computerId: null,
    tmuxSession: null,
    agentWorkspaceId: null,
    environmentId: "e1",
    checkouts: null,
    agent: "claude",
    model: null,
    mode: "build",
    lastActiveAt: null,
    errorMessage: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
  const json = workspaceJson(workspace, "https://app.example");
  assert.equal(json.status, "preparing");
  assert.equal(json.setup_phase, "clone");
  assert.equal(json.source, "api");
  assert.equal(json.user_id, "u1");
  assert.equal(json.url, "https://app.example/workspaces/w1");
  assert.equal(workspaceJson({ ...workspace, status: "ready" }, "https://app.example").setup_phase, null);
});

test("a body's fields go to the app's routes in their names, nested values as sent", () => {
  const schedules = [{ kind: "weekly", timezone: "UTC", days: [1], time: "09:00" }];
  assert.deepEqual(topLevelCamel({ max_runs: 3, archive_when_done: true, project_ids: ["p"], name: "Nightly", schedules }), {
    maxRuns: 3,
    archiveWhenDone: true,
    projectIds: ["p"],
    name: "Nightly",
    schedules,
  });
});

test("a project in full names its secrets, never their values", () => {
  const json = environmentDetailJson({
    id: "e1",
    orgId: "o1",
    name: "Web",
    description: null,
    instructions: "Use pnpm.",
    repos: [{ projectId: "p1", fullName: "acme/web", checkoutName: "web", branch: null, defaultBranch: "main" }],
    envNames: ["API_KEY"],
    filePaths: [".env"],
    scripts: { setup: "pnpm i", run: null, archive: null },
    hooks: { warm: null, start: null },
    defaultForProjectId: "p1",
    setupGeneration: 1,
    warm: null,
    updatedAt: "2026-10-31T00:00:00Z",
    access: "write",
  } as unknown as Parameters<typeof environmentDetailJson>[0]);
  assert.deepEqual(json.variable_names, ["API_KEY"]);
  assert.deepEqual(json.file_paths, [".env"]);
  assert.equal(json.instructions, "Use pnpm.");
  assert.equal(JSON.stringify(json).includes("secret"), false);
});
