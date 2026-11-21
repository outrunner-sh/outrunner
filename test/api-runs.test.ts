import assert from "node:assert/strict";
import { test } from "node:test";

import type { ConversationEntry } from "@/lib/api/conversation";
import { firstRunPending, FIRST_RUN, isPrompt, pendingFirstRun, runsFrom, sessionUsage, usageOf } from "@/lib/api/runs";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";

const text = (t: string) => ({ type: "text", text: t });
const usage = (input: number, output: number, cacheWrite = 0, cacheRead = 0) => ({
  input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead,
});
function message(uuid: string, role: "user" | "assistant", content: unknown[], at: string, extra: Record<string, unknown> = {}): AgentEvent {
  return { t: "message", uuid, parentUuid: null, role, timestamp: `2026-11-14T10:${at}Z`, content, ...extra } as AgentEvent;
}
const entries = (events: AgentEvent[]): ConversationEntry[] => events.map((event, i) => ({ id: (i + 1) * 100, event }));

const toolUse = { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pnpm test" } };
const toolResult = { type: "tool_result", tool_use_id: "toolu_1", content: "ok" };

const twoRuns = entries([
  message("p1", "user", [text("Make the header sticky")], "00:00"),
  message("a1", "assistant", [text("On it.")], "00:05", { usage: usage(100, 10, 50, 0) }),
  message("a2", "assistant", [toolUse], "00:06", { usage: usage(100, 30, 50, 0), stopReason: "tool_use" }),
  message("u1", "user", [toolResult], "00:20"),
  message("a3", "assistant", [text("Done: the header sticks.")], "00:30", { usage: usage(20, 40, 0, 150), stopReason: "end_turn" }),
  message("p2", "user", [text("Also on mobile")], "01:00"),
  message("a4", "assistant", [text("Working on mobile.")], "01:02", { usage: usage(10, 5) }),
]);

test("a run is a prompt and what followed it, up to the next", () => {
  const runs = runsFrom(twoRuns, "running");
  assert.deepEqual(runs.map((r) => [r.id, r.number, r.prompt]), [["100", 1, "Make the header sticky"], ["600", 2, "Also on mobile"]]);
  assert.equal(runs[0].first_event, "100");
  assert.equal(runs[0].last_event, "500");
});

test("an earlier run is over, with what it said and how long it took", () => {
  const [first] = runsFrom(twoRuns, "running");
  assert.equal(first.status, "finished");
  assert.equal(first.result, "Done: the header sticks.");
  assert.equal(first.ended_at, "2026-11-14T10:00:30Z");
  assert.equal(first.duration_ms, 30_000);
  assert.equal(first.error, null);
});

test("the newest run follows the turn: running while it works, finished once it's over", () => {
  const working = [...twoRuns.slice(0, 6)];
  assert.equal(runsFrom(working, "running").at(-1)!.status, "running");
  assert.equal(runsFrom(working, "running").at(-1)!.ended_at, null);
  assert.equal(runsFrom(working, "running").at(-1)!.result, null);
  const over = entries([message("p", "user", [text("hi")], "00:00"), message("a", "assistant", [text("Hello.")], "00:01", { stopReason: "end_turn" })]);
  assert.equal(runsFrom(over, "running")[0].status, "finished");
});

test("a stopped run is cancelled, and a failed one says why", () => {
  const stopped = runsFrom(entries([
    message("p", "user", [text("refactor it")], "00:00"),
    message("a", "assistant", [toolUse], "00:01", { stopReason: "tool_use" }),
    message("i", "user", [text("[Request interrupted by user for tool use]")], "00:02"),
    message("p2", "user", [text("never mind")], "00:03"),
    message("a2", "assistant", [text("OK.")], "00:04", { stopReason: "end_turn" }),
  ]), "running");
  assert.equal(stopped.length, 2);
  assert.equal(stopped[0].status, "cancelled");
  const failed = runsFrom(entries([
    message("p", "user", [text("go")], "00:00"),
    message("e", "assistant", [text("API Error: 529 Overloaded")], "00:01", { model: "<synthetic>", stopReason: "stop_sequence" }),
    message("p2", "user", [text("again")], "00:02"),
  ]), "running");
  assert.equal(failed[0].status, "error");
  assert.equal(failed[0].error, "API Error: 529 Overloaded");
  assert.equal(failed[0].result, null);
});

test("a tool's result, a stopped turn or a skill's instructions aren't prompts", () => {
  assert.equal(isPrompt(message("u", "user", [toolResult], "00:00")), false);
  assert.equal(isPrompt(message("u", "user", [text("[Request interrupted by user]")], "00:00")), false);
  assert.equal(isPrompt(message("u", "user", [text("Base directory for this skill…")], "00:00", { meta: true })), false);
  assert.equal(isPrompt(message("u", "user", [text("<local-command-stdout>Compacted</local-command-stdout>")], "00:00")), false);
  assert.equal(isPrompt(message("a", "assistant", [text("hi")], "00:00")), false);
  assert.equal(isPrompt(message("u", "user", [text("fix it")], "00:00")), true);
});

test("a model call logged as several records counts once", () => {
  // a1 and a2 are one call (its words, then its tool call): 100 in, 30 out, 50 cache written.
  const [first, second] = runsFrom(twoRuns, "running");
  assert.deepEqual(first.usage, { input_tokens: 120, output_tokens: 70, cache_creation_input_tokens: 50, cache_read_input_tokens: 150, total_tokens: 390 });
  assert.deepEqual(second.usage, { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, total_tokens: 15 });
  const total = sessionUsage(twoRuns, [first, second]);
  assert.equal(total.total.total_tokens, 405);
  assert.deepEqual(total.runs.map((r) => r.id), ["100", "600"]);
});

test("usage an engine logs apart counts as it comes", () => {
  const events = [{ t: "usage", ...usage(5, 6, 7, 8) }, { t: "usage", ...usage(1, 1, 1, 1) }] as AgentEvent[];
  assert.deepEqual(usageOf(events), { input_tokens: 6, output_tokens: 7, cache_creation_input_tokens: 8, cache_read_input_tokens: 9, total_tokens: 30 });
});

test("a conversation with no prompt has no runs", () => {
  assert.deepEqual(runsFrom([], null), []);
});

test("a session's first run is there before its prompt is logged: while it's set up, or just ready", () => {
  const none: never[] = [];
  const now = Date.parse("2026-11-18T10:00:00Z");
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const session = (status: string, minutesAgo = 1) => ({ status, errorMessage: status === "failed" ? "No box" : null, createdAt: at(minutesAgo) }) as never;
  assert.equal(firstRunPending(session("creating"), none, "none", now), true);
  assert.equal(firstRunPending(session("ready"), none, "live", now), true);
  assert.equal(firstRunPending(session("failed"), none, "none", now), true);
  // Ready long since with no runs: started without a prompt (a Mission can
  // be), so none is coming.
  assert.equal(firstRunPending(session("ready", 30), none, "live", now), false);
  // Paused, or woken, with nothing read: no run to make up.
  assert.equal(firstRunPending(session("suspended"), none, "none", now), false);
  assert.equal(firstRunPending(session("resuming"), none, "none", now), false);
  assert.equal(firstRunPending(session("creating"), runsFrom(twoRuns, "running"), "live", now), false);
  assert.equal(FIRST_RUN, "run-1");
  const createdAt = "2026-11-21T09:14:04.132Z";
  assert.deepEqual([pendingFirstRun({ status: "creating", errorMessage: null, createdAt }).status, pendingFirstRun({ status: "failed", errorMessage: "No box", createdAt }).error], ["preparing", "No box"]);
});

test("a first run not begun started with its session, never at no time", () => {
  // As POST /workspaces answers it: a client timing the run from started_at
  // read null as 1970, so the run was "going" for decades a minute in, and
  // given up on before its box was up.
  const createdAt = "2026-11-21T09:14:04.132Z";
  for (const status of ["creating", "provisioning", "ready", "failed"]) {
    const run = pendingFirstRun({ status, errorMessage: null, createdAt } as never);
    assert.equal(run.started_at, createdAt, status);
    assert.ok(Date.parse(String(run.started_at)) > 0, status);
  }
});
