import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCreate } from "@/lib/api/create-request";
import {
  artifactIdOf,
  artifactPath,
  createFromCursor,
  cursorAgentJson,
  cursorAgentStatus,
  cursorPage,
  cursorPaging,
  cursorRunId,
  cursorRunJson,
  cursorModelItems,
  cursorStreamEvent,
  cursorUsageJson,
  findRun,
  followUpFromCursor,
  pendingRunJson,
  runRef,
  sessionIdOf,
} from "@/lib/api/cursor";
import type { Run } from "@/lib/api/runs";
import type { StreamEvent } from "@/lib/api/stream";

const usage = { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, total_tokens: 3 };
function run(number: number, status: Run["status"], extra: Partial<Run> = {}): Run {
  return {
    id: String(number * 100),
    number,
    prompt: "Add a README",
    status,
    started_at: "2026-11-17T10:00:00Z",
    ended_at: status === "running" || status === "needs_input" ? null : "2026-11-17T10:02:00Z",
    duration_ms: status === "running" || status === "needs_input" ? null : 120_000,
    result: status === "finished" ? "Added README.md." : null,
    error: null,
    pending_input: null,
    usage,
    first_event: String(number * 100),
    last_event: String(number * 100 + 50),
    ...extra,
  };
}

// The create a script written for Cursor sends, as it sends it.
const cursorCreate = {
  name: "readme-agent",
  prompt: { text: "Add a README with setup instructions" },
  model: { id: "composer-2" },
  repos: [{ url: "https://github.com/walkover-Web-Solution/viasocket", startingRef: "main" }],
  autoCreatePR: true,
};

test("Cursor's create reads as a session's, with its own model left to the default", () => {
  const read = createFromCursor(cursorCreate);
  assert.ok(typeof read !== "string");
  assert.deepEqual(read.body, {
    prompt: "Add a README with setup instructions",
    name: "readme-agent",
    repo_url: "https://github.com/walkover-Web-Solution/viasocket",
    base_branch: "main",
    auto_create_pr: true,
  });
  assert.equal(read.agentId, null);
  assert.equal(read.envName, null);
  const input = parseCreate(read.body);
  assert.ok(typeof input !== "string");
  assert.equal(input.repoFullName, "walkover-Web-Solution/viasocket");
  assert.equal(input.baseBranch, "main");
  assert.equal(input.autoCreatePr, true);
  assert.equal(input.model, undefined);
});

test("a model of ours, images, plan mode, a pull request and an agentId carry over", () => {
  const read = createFromCursor({
    prompt: { text: "Fix it", images: [{ url: "https://example.com/a.png" }] },
    model: { id: "claude-opus-4-5" },
    repos: [{ url: "github.com/acme/web", prUrl: "https://github.com/acme/web/pull/7" }],
    workOnCurrentBranch: true,
    mode: "plan",
    agentId: "bc-1b4e28ba-2fa1-11d2-883f-0016d3cca427",
  });
  assert.ok(typeof read !== "string");
  assert.deepEqual(read.body, {
    prompt: "Fix it",
    images: [{ url: "https://example.com/a.png" }],
    model: "claude-opus-4-5",
    repo_url: "github.com/acme/web",
    pr_url: "https://github.com/acme/web/pull/7",
    work_on_current_branch: true,
    plan_mode: true,
  });
  assert.equal(read.agentId, "bc-1b4e28ba-2fa1-11d2-883f-0016d3cca427");
});

test("Outrunner's own fields go along, so a project of several repositories can be named", () => {
  const read = createFromCursor({ prompt: { text: "Go" }, environment_id: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", effort: "high" });
  assert.ok(typeof read !== "string");
  assert.deepEqual(read.body, { prompt: "Go", environment_id: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", effort: "high" });
});

test("Cursor's per-agent variables, MCP servers and subagents go as the session's own", () => {
  const read = createFromCursor({
    ...cursorCreate,
    envVars: { API_KEY: "x" },
    mcpServers: [{ name: "linear", url: "https://mcp.linear.app/sse", type: "sse" }],
    customSubagents: [{ name: "reviewer", description: "Reviews", prompt: "Review it." }],
  });
  assert.ok(typeof read !== "string");
  assert.deepEqual(read.body.env, { API_KEY: "x" });
  assert.deepEqual(read.body.mcp_servers, [{ name: "linear", url: "https://mcp.linear.app/sse", type: "sse" }]);
  assert.deepEqual(read.body.subagents, [{ name: "reviewer", description: "Reviews", prompt: "Review it." }]);
  const input = parseCreate(read.body);
  assert.ok(typeof input !== "string");
  assert.deepEqual(input.overrides, {
    env: { API_KEY: "x" },
    mcpServers: { linear: { type: "sse", url: "https://mcp.linear.app/sse" } },
    subagents: { reviewer: { description: "Reviews", prompt: "Review it." } },
  });
});

test("what Cursor's request can't be is refused, saying why", () => {
  assert.match(createFromCursor({ ...cursorCreate, repos: [{ url: "acme/a" }, { url: "acme/b" }] }) as string, /environment_id/);
  assert.match(createFromCursor({ ...cursorCreate, mode: "ask" }) as string, /agent or plan/);
  assert.match(createFromCursor({ ...cursorCreate, model: { id: 3 } }) as string, /GET \/api\/v1\/models/);
  assert.match(createFromCursor({ ...cursorCreate, prompt: 42 }) as string, /`prompt`/);
  assert.match(followUpFromCursor({ prompt: { text: "x" }, mcpServers: [{ name: "a", url: "https://a.example" }] }) as string, /as it's created/);
});

test("a follow-up reads as a message; steer and plan mode carry over", () => {
  assert.deepEqual(followUpFromCursor({ prompt: { text: "Change of plan: instead of X, do Y" } }), {
    body: { content: "Change of plan: instead of X, do Y" },
    steer: false,
  });
  assert.deepEqual(followUpFromCursor({ prompt: { text: "Stop" }, delivery: "steer" }), { body: { content: "Stop" }, steer: true });
  assert.deepEqual(followUpFromCursor({ prompt: { text: "Plan it" }, mode: "plan" }), { body: { content: "Plan it", mode: "plan" }, steer: false });
  assert.deepEqual(followUpFromCursor({ prompt: { text: "Do it" }, mode: "agent" }), { body: { content: "Do it", mode: "build" }, steer: false });
  assert.match(followUpFromCursor({ prompt: { text: "x" }, delivery: "queue" }) as string, /steer/);
});

test("runs are named by their place, and found by it or by their own id", () => {
  assert.equal(cursorRunId(2), "run-2");
  assert.deepEqual(runRef("run-2"), { number: 2 });
  assert.deepEqual(runRef("300"), { id: "300" });
  assert.equal(runRef("run-0"), null);
  assert.equal(runRef("abc"), null);
  const runs = [run(1, "finished"), run(2, "running")];
  assert.equal(findRun(runs, { number: 2 })?.id, "200");
  assert.equal(findRun(runs, { id: "100" })?.number, 1);
  assert.equal(findRun(runs, { number: 3 }), undefined);
  assert.equal(sessionIdOf("bc-1b4e28ba-2fa1-11d2-883f-0016d3cca427"), "1b4e28ba-2fa1-11d2-883f-0016d3cca427");
});

test("an ended run says its result, duration and branch; one going on doesn't", () => {
  const git = [{ fullName: "acme/web", branch: "feat/readme", prUrl: "https://github.com/acme/web/pull/9" }];
  assert.deepEqual(cursorRunJson(run(1, "finished"), "w1", git), {
    id: "run-1",
    agentId: "w1",
    status: "FINISHED",
    createdAt: "2026-11-17T10:00:00Z",
    updatedAt: "2026-11-17T10:02:00Z",
    durationMs: 120_000,
    result: "Added README.md.",
    git: { branches: [{ repoUrl: "github.com/acme/web", branch: "feat/readme", prUrl: "https://github.com/acme/web/pull/9" }] },
  });
  const going = cursorRunJson(run(2, "running"), "w1", git);
  assert.equal(going.status, "RUNNING");
  assert.equal("result" in going, false);
  const asking = cursorRunJson(run(2, "needs_input", { pending_input: { type: "question" } }), "w1", git);
  assert.equal(asking.status, "RUNNING");
  assert.deepEqual(asking.pendingInput, { type: "question" });
  const failed = cursorRunJson(run(1, "error", { error: "Usage limit reached" }), "w1", []);
  assert.equal(failed.status, "ERROR");
  assert.equal(failed.error, "Usage limit reached");
  assert.equal(cursorRunJson(run(1, "finished"), "w1", [{ fullName: "gitlab.com/g/p", branch: "b", prUrl: null }]).git !== undefined, true);
});

test("the first run is there before its prompt: creating, or an error when the setup failed", () => {
  assert.equal(pendingRunJson(1, "w1", { status: "preparing" }).status, "CREATING");
  assert.deepEqual(pendingRunJson(1, "w1", { status: "failed", created_at: "t0", updated_at: "t1", error_message: "No box" }), {
    id: "run-1",
    agentId: "w1",
    status: "ERROR",
    createdAt: "t0",
    updatedAt: "t1",
    error: "No box",
  });
});

test("an agent is active while set up or on a turn, idle between, archived once archived", () => {
  assert.equal(cursorAgentStatus("preparing", null), "ACTIVE");
  assert.equal(cursorAgentStatus("ready", "working"), "ACTIVE");
  assert.equal(cursorAgentStatus("ready", "needs_input"), "ACTIVE");
  assert.equal(cursorAgentStatus("ready", "idle"), "IDLE");
  assert.equal(cursorAgentStatus("suspended", null), "IDLE");
  assert.equal(cursorAgentStatus("archived", null), "ARCHIVED");
});

test("a session reads as Cursor's agent", () => {
  const session = { id: "w1", title: "readme-agent", url: "https://app.outrunner.sh/workspaces/w1", created_at: "t0", updated_at: "t1" };
  assert.deepEqual(
    cursorAgentJson(session, { status: "ACTIVE", latestRunId: "run-1", repos: [{ fullName: "acme/web", startingRef: "main" }], autoCreatePR: true }),
    {
      id: "w1",
      name: "readme-agent",
      status: "ACTIVE",
      env: { type: "cloud" },
      repos: [{ url: "https://github.com/acme/web", startingRef: "main" }],
      autoCreatePR: true,
      url: "https://app.outrunner.sh/workspaces/w1",
      createdAt: "t0",
      updatedAt: "t1",
      latestRunId: "run-1",
    },
  );
  assert.deepEqual(Object.keys(cursorAgentJson(session, { status: "IDLE" })), ["id", "name", "status", "env", "url", "createdAt", "updatedAt"]);
});

const ev = (event: string, data: Record<string, unknown>, id: string | null = "10"): StreamEvent => ({ event, id, data });

test("a run's stream says its status in Cursor's words: creating until it begins, running, then its result", () => {
  const target = { run: { number: 2 } };
  const say = (e: StreamEvent) => cursorStreamEvent(e, target);
  assert.deepEqual(say(ev("status", { state: "preparing", setup_phase: "clone" }, null))?.data, { runId: "run-2", status: "CREATING" });
  // The run before it is the newest: it hasn't begun.
  assert.deepEqual(say(ev("status", { state: "working", run_id: "100", run_number: 1 }, null))?.data, { runId: "run-2", status: "CREATING" });
  assert.deepEqual(say(ev("status", { state: "working", run_id: "200", run_number: 2 }, null))?.data, { runId: "run-2", status: "RUNNING" });
  // Its end is its result; a later run's start isn't its news.
  assert.equal(say(ev("status", { state: "idle", run_id: "200", run_number: 2 }, null)), null);
  assert.equal(say(ev("status", { state: "working", run_id: "300", run_number: 3 }, null)), null);
  assert.equal(say(ev("prompt", { run_id: "200", run_number: 2, text: "x" })), null);
  assert.deepEqual(say(ev("result", { run_id: "200", run_number: 2, status: "finished", text: "Done.", error: null, duration_ms: 900, usage }, "250")), {
    event: "result",
    id: "250",
    data: { runId: "run-2", status: "FINISHED", text: "Done.", durationMs: 900 },
  });
  // Named by its own id, the same.
  assert.deepEqual(cursorStreamEvent(ev("status", { state: "working", run_id: "200", run_number: 2 }, null), { run: { id: "200" } })?.data, { runId: "200", status: "RUNNING" });
});

test("words, tool calls and questions are said in Cursor's words; heartbeats and the end as they are", () => {
  const target = { run: { number: 1 } };
  assert.deepEqual(cursorStreamEvent(ev("assistant", { uuid: "a1", text: "Hel" }), target), ev("assistant", { text: "Hel" }));
  assert.deepEqual(cursorStreamEvent(ev("thinking", { uuid: "a1", text: "First, the tests." }), target), ev("thinking", { text: "First, the tests." }));
  assert.deepEqual(cursorStreamEvent(ev("tool_call", { call_id: "t1", name: "Bash", status: "completed", args: { command: "ls" }, result: "a", is_error: true }), target)?.data, {
    callId: "t1",
    name: "Bash",
    status: "completed",
    args: { command: "ls" },
    result: "a",
    isError: true,
  });
  assert.deepEqual(cursorStreamEvent(ev("needs_input", { run_id: "100", run_number: 1, pending_input: { type: "question" } }), target)?.data, {
    runId: "run-1",
    pendingInput: { type: "question" },
  });
  const beat = ev("heartbeat", {}, null);
  assert.equal(cursorStreamEvent(beat, target), beat);
  const done = ev("done", { reconnect: true }, null);
  assert.equal(cursorStreamEvent(done, target), done);
});

test("the agent's stream says active or idle, and no run's result", () => {
  const target = { agentId: "w1" };
  assert.deepEqual(cursorStreamEvent(ev("status", { state: "working", run_id: "100", run_number: 1 }, null), target)?.data, { agentId: "w1", status: "ACTIVE" });
  assert.deepEqual(cursorStreamEvent(ev("status", { state: "preparing" }, null), target)?.data, { agentId: "w1", status: "ACTIVE" });
  assert.deepEqual(cursorStreamEvent(ev("status", { state: "idle", run_id: "100", run_number: 1 }, null), target)?.data, { agentId: "w1", status: "IDLE" });
  assert.equal(cursorStreamEvent(ev("result", { run_id: "100", run_number: 1, status: "finished" }), target), null);
});

test("lists page by limit and cursor, with nextCursor left out on the last page", () => {
  assert.deepEqual(cursorPaging(new URLSearchParams("")), { page: 1, perPage: 20 });
  assert.deepEqual(cursorPaging(new URLSearchParams("limit=5&cursor=3")), { page: 3, perPage: 5 });
  assert.match(cursorPaging(new URLSearchParams("limit=101")) as string, /limit/);
  assert.match(cursorPaging(new URLSearchParams("cursor=abc")) as string, /nextCursor/);
  assert.deepEqual(cursorPage([1], { page: 2, has_more: true }), { items: [1], nextCursor: "3" });
  assert.deepEqual(cursorPage([1], { page: 2, has_more: false }), { items: [1] });
});

test("a named cloud environment is a project; the model's effort param is its effort", () => {
  const read = createFromCursor({ prompt: { text: "Go" }, env: { type: "cloud", name: " Web + API " }, model: { id: "opus", params: [{ id: "effort", value: "high" }] } });
  assert.ok(typeof read !== "string");
  assert.equal(read.envName, "Web + API");
  assert.deepEqual(read.body, { prompt: "Go", model: "opus", effort: "high" });
  assert.ok(typeof createFromCursor({ prompt: { text: "Go" }, env: { type: "cloud" }, repos: [{ url: "acme/web" }] }) !== "string");
  assert.match(createFromCursor({ prompt: { text: "Go" }, env: { type: "pool", name: "default" } }) as string, /Outrunner's boxes/);
  assert.match(createFromCursor({ prompt: { text: "Go" }, env: { type: "cloud", name: "x" }, repos: [{ url: "acme/web" }] }) as string, /not both/);
  assert.match(createFromCursor({ prompt: { text: "Go" }, model: { id: "opus", params: [{ id: "effort" }] } }) as string, /effort/);
  assert.match(createFromCursor({ prompt: { text: "Go" }, model: { id: "opus", params: "high" } }) as string, /model\.params/);
});

test("usage is counted as Cursor counts it, in all and by run", () => {
  const total = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, total_tokens: 37 };
  assert.deepEqual(cursorUsageJson(total, [run(1, "finished")]), {
    totalUsage: { inputTokens: 10, outputTokens: 20, cacheWriteTokens: 3, cacheReadTokens: 4, totalTokens: 37 },
    runs: [{ id: "run-1", usage: { inputTokens: 1, outputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 3 } }],
  });
});

test("an artifact's path is under artifacts/, and names it by its id", () => {
  const media = { id: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", name: "Settings page, after [mobile]", contentType: "image/png" as const };
  const path = artifactPath(media);
  assert.equal(path, "artifacts/1b4e28ba-2fa1-11d2-883f-0016d3cca427/Settings-page-after-mobile.png");
  assert.equal(artifactIdOf(path), media.id);
  assert.equal(artifactIdOf(`artifacts/${media.id}`), media.id);
  assert.equal(artifactIdOf("artifacts/screenshot.png"), null);
  assert.equal(artifactIdOf(`../artifacts/${media.id}/x.png`), null);
  assert.equal(artifactIdOf(null), null);
  assert.equal(artifactPath({ ...media, name: "***", contentType: "video/mp4" }), `artifacts/${media.id}/artifact.mp4`);
});

test("models list as Cursor's items, an effort a parameter", () => {
  assert.deepEqual(
    cursorModelItems([
      { id: "opus", label: "Opus", group: "Claude", efforts: ["low", "high"], default_effort: "high" },
      { id: "auto", label: "Auto", group: "Outrunner", efforts: [], default_effort: null },
    ]),
    [
      { id: "opus", displayName: "Opus", description: "Claude", aliases: [], parameters: [{ id: "effort", values: ["low", "high"], default: "high" }] },
      { id: "auto", displayName: "Auto", description: "Outrunner", aliases: [], parameters: [] },
    ],
  );
});

test("null is left out as absent, as a Python client's None", () => {
  const read = createFromCursor({ prompt: { text: "Go" }, name: null, repos: [{ url: "acme/web", startingRef: null, prUrl: null }] });
  assert.ok(typeof read !== "string");
  assert.deepEqual(read.body, { prompt: "Go", repo_url: "acme/web" });
});
