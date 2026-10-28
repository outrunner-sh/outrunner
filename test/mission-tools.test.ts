import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_RUNNERS, runnerPlacesLeft, runnerState } from "@/lib/missions/rules";
import { callMissionTool, type MissionToolDeps, type RunnerStart } from "@/lib/missions/tools";
import type { Workspace, WorkspaceStatus } from "@/lib/runtime/types";

function session(id: string, patch: Partial<Workspace> = {}): Workspace {
  return {
    id,
    projectId: "p1",
    ownerId: "alice",
    provider: "daytona",
    status: "ready",
    phase: null,
    branch: `runtime/${id}`,
    title: id,
    baseBranch: "main",
    worktreePath: "/w",
    sandboxId: null,
    volumeName: null,
    computerId: null,
    tmuxSession: null,
    agentWorkspaceId: null,
    environmentId: "env1",
    checkouts: null,
    agent: "claude",
    model: null,
    lastActiveAt: null,
    errorMessage: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    kind: "session",
    parentMissionId: null,
    ...patch,
  };
}

/** Two Missions of Alice's, one of Bob's, their Runners, and a plain session. */
function world(extra: Workspace[] = []) {
  const sessions = [
    session("m1", { kind: "mission" }),
    session("m2", { kind: "mission" }),
    session("mb", { kind: "mission", ownerId: "bob" }),
    session("r1", { parentMissionId: "m1" }),
    session("r2", { parentMissionId: "m2" }),
    session("rb", { parentMissionId: "mb", ownerId: "bob" }),
    session("plain"),
    ...extra,
  ];
  const calls: string[] = [];
  const started: RunnerStart[] = [];
  const queued: string[] = [];
  let notes = "";
  const state = { denied: null as string | null, notReady: null as string | null };
  const deps: MissionToolDeps = {
    access: async () => state.denied,
    environmentReady: async () => state.notReady,
    session: async (id) => sessions.find((s) => s.id === id) ?? null,
    runners: async (missionId) => sessions.filter((s) => s.parentMissionId === missionId),
    working: async (s) => s.id.startsWith("busy"),
    latestResponse: async (s) => `latest from ${s.id}`,
    pullRequests: async (s) =>
      s.id.startsWith("pr")
        ? [
            {
              repo: "acme/app",
              number: 7,
              url: "https://github.com/acme/app/pull/7",
              title: "x",
              status: { state: "open", draft: false, mergeableState: "clean", headSha: "abc", checks: { passing: 3, failing: 0, pending: 0 } },
              verdict: { label: "Ready to merge", tone: "ready", canMerge: true, why: "" },
            },
          ]
        : [],
    startRunner: async (_mission, start) => {
      started.push(start);
      return { runnerId: "new" };
    },
    send: async (runner, content) => {
      calls.push(`send ${runner.id}: ${content}`);
      return true;
    },
    queue: async (_m, runnerId, content) => {
      queued.push(`${runnerId}: ${content}`);
    },
    queued: async () => new Map(),
    archive: async (runner) => {
      calls.push(`archive ${runner.id}`);
      return true;
    },
    readNotes: async () => ({ body: notes, updatedAt: null }),
    writeNotes: async (_m, body) => {
      notes = body;
    },
  };
  return { deps, calls, started, queued, state };
}

test("a Mission's token reaches its own Runners and nothing else", async () => {
  const { deps, calls } = world();
  const scope = { missionId: "m1" };
  for (const other of ["r2", "rb", "plain", "m2", "m1", "nope", ""]) {
    for (const tool of ["message_runner", "read_runner", "archive_runner"]) {
      const result = await callMissionTool(scope, tool, { runner_id: other, message: "hi" }, deps);
      assert.equal(result.isError, true, `${tool} ${other}`);
      // Another Mission's Runner reads exactly as no Runner: nothing learned.
      assert.match(result.text, /no Runner with that id/, `${tool} ${other}`);
    }
  }
  assert.deepEqual(calls, []);
  const own = await callMissionTool(scope, "message_runner", { runner_id: "r1", message: "go" }, deps);
  assert.equal(own.isError, undefined);
  assert.deepEqual(calls, ["send r1: go"]);
});

test("list_runners lists only the Mission's own", async () => {
  const { deps } = world();
  const listed = JSON.parse((await callMissionTool({ missionId: "m1" }, "list_runners", {}, deps)).text);
  assert.deepEqual(
    listed.runners.map((r: { id: string }) => r.id),
    ["r1"],
  );
  assert.equal(listed.places_left, MAX_RUNNERS - 1);
});

test("a token for a session that isn't a Mission, or one that's gone, does nothing", async () => {
  const { deps } = world([session("dead", { kind: "mission", status: "destroyed" })]);
  for (const missionId of ["plain", "r1", "dead", "nope"]) {
    const result = await callMissionTool({ missionId }, "list_runners", {}, deps);
    assert.equal(result.isError, true, missionId);
  }
});

test("a Runner of another owner's Mission is never reached, even named as its parent", async () => {
  // A row claiming m1 as its parent but owned by someone else.
  const { deps, calls } = world([session("stray", { parentMissionId: "m1", ownerId: "mallory" })]);
  const result = await callMissionTool({ missionId: "m1" }, "message_runner", { runner_id: "stray", message: "hi" }, deps);
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
});

test("spawn_runner stops at the cap, counting only Runners that aren't archived", async () => {
  const runners = (n: number, status: WorkspaceStatus) =>
    Array.from({ length: n }, (_, i) => session(`${status}-${i}`, { parentMissionId: "m1", status }));
  const full = world(runners(MAX_RUNNERS - 1, "ready"));
  // r1 is the twentieth.
  const refused = await callMissionTool({ missionId: "m1" }, "spawn_runner", { prompt: "do it" }, full.deps);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /20 Runners/);
  assert.equal(full.started.length, 0);

  const archived = world([...runners(MAX_RUNNERS - 2, "ready"), ...runners(5, "archived"), ...runners(3, "failed")]);
  const ok = await callMissionTool({ missionId: "m1" }, "spawn_runner", { prompt: "do it", name: "Fix login" }, archived.deps);
  assert.equal(ok.isError, undefined, ok.text);
  assert.equal(JSON.parse(ok.text).runner_id, "new");
  assert.deepEqual(archived.started, [{ brief: "do it", planMode: false, name: "Fix login", model: undefined, agent: undefined, effort: undefined }]);
});

test("the places left count what holds one", () => {
  const of = (...statuses: WorkspaceStatus[]) => statuses.map((status) => ({ status }));
  assert.equal(runnerPlacesLeft(of("ready", "suspended", "provisioning", "archiving")), MAX_RUNNERS - 4);
  assert.equal(runnerPlacesLeft(of("archived", "destroyed", "failed", "destroying")), MAX_RUNNERS);
  assert.equal(runnerPlacesLeft(of(...Array.from({ length: 25 }, () => "ready" as const))), 0);
});

test("plan mode asks for a plan before the brief", async () => {
  const { deps, started } = world();
  await callMissionTool({ missionId: "m1" }, "spawn_runner", { prompt: "rewrite auth", plan_mode: true }, deps);
  // The brief stays the Mission's own (its name, the Runners pane); plan mode
  // rides with it, and only the first message asks for a plan.
  assert.deepEqual(started[0], { brief: "rewrite auth", planMode: true, name: undefined, model: undefined, agent: undefined, effort: undefined });
});

test("message_runner steers a working Runner, or queues when asked", async () => {
  const { deps, calls, queued } = world([session("busy1", { parentMissionId: "m1" })]);
  const steered = await callMissionTool({ missionId: "m1" }, "message_runner", { runner_id: "busy1", message: "also X" }, deps);
  assert.match(steered.text, /steers/);
  const held = await callMissionTool({ missionId: "m1" }, "message_runner", { runner_id: "busy1", message: "then Y", queue: true }, deps);
  assert.match(held.text, /Queued/);
  assert.deepEqual(calls, ["send busy1: also X"]);
  assert.deepEqual(queued, ["busy1: then Y"]);
});

test("archive_runner refuses a working one or one with an open PR, unless forced", async () => {
  const { deps, calls } = world([session("busy1", { parentMissionId: "m1" }), session("pr1", { parentMissionId: "m1" })]);
  const scope = { missionId: "m1" };
  assert.match((await callMissionTool(scope, "archive_runner", { runner_id: "busy1" }, deps)).text, /working/);
  assert.match((await callMissionTool(scope, "archive_runner", { runner_id: "pr1" }, deps)).text, /open pull request/);
  assert.deepEqual(calls, []);
  await callMissionTool(scope, "archive_runner", { runner_id: "pr1", force: true }, deps);
  await callMissionTool(scope, "archive_runner", { runner_id: "r1" }, deps);
  assert.deepEqual(calls, ["archive pr1", "archive r1"]);
});

test("notes are the Mission's, and capped", async () => {
  const { deps } = world();
  assert.match((await callMissionTool({ missionId: "m1" }, "read_notes", {}, deps)).text, /No notes yet/);
  await callMissionTool({ missionId: "m1" }, "write_notes", { content: "# Billing\n- decided X" }, deps);
  assert.equal((await callMissionTool({ missionId: "m1" }, "read_notes", {}, deps)).text, "# Billing\n- decided X");
  const big = await callMissionTool({ missionId: "m1" }, "write_notes", { content: "x".repeat(70000) }, deps);
  assert.equal(big.isError, true);
});

test("a Runner's state reads from its status and whether it's mid-turn", () => {
  assert.equal(runnerState("provisioning", false), "setting_up");
  assert.equal(runnerState("ready", true), "working");
  assert.equal(runnerState("idle", false), "idle");
  assert.equal(runnerState("suspended", false), "asleep");
  assert.equal(runnerState("archived", false), "archived");
  assert.equal(runnerState("failed", false), "failed");
});

test("access is asked on every call: taken away, the tools stop", async () => {
  const { deps, calls, state } = world();
  assert.equal((await callMissionTool({ missionId: "m1" }, "message_runner", { runner_id: "r1", message: "a" }, deps)).isError, undefined);
  state.denied = "The Mission's owner can no longer read its project, so its tools are off.";
  for (const tool of ["list_runners", "read_notes", "spawn_runner", "message_runner"]) {
    const result = await callMissionTool({ missionId: "m1" }, tool, { runner_id: "r1", message: "b", prompt: "x" }, deps);
    assert.equal(result.isError, true, tool);
    assert.match(result.text, /can no longer read/);
  }
  assert.deepEqual(calls, ["send r1: a"]);
});

test("spawn_runner says why when the project isn't ready", async () => {
  const { deps, started, state } = world();
  state.notReady = "the Mission's project is gone or archived.";
  const result = await callMissionTool({ missionId: "m1" }, "spawn_runner", { prompt: "do it" }, deps);
  assert.equal(result.isError, true);
  assert.match(result.text, /didn't start: the Mission's project is gone/);
  assert.equal(started.length, 0);
});
