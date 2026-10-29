import assert from "node:assert/strict";
import { test } from "node:test";

import { KEPT_PAGE_CHARS, keptPage } from "@/lib/client/kept-page";
import { fallbackStanding } from "@/lib/nav/status-groups";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { workingStep } from "@/lib/runtime/conversation-events";
import type { Workspace } from "@/lib/runtime/types";
import { optimisticSession } from "@/lib/session/pending-sessions";
import { rowsAhead } from "@/lib/session/rows-ahead";

/** localStorage, with a quota in characters when given one. */
class FakeStorage {
  readonly items = new Map<string, string>();
  private readonly quota: number;
  constructor(quota = Infinity) {
    this.quota = quota;
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (value.length > this.quota) throw new Error("QuotaExceededError");
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

const isList = (value: unknown): value is { names: string[] } =>
  Array.isArray((value as { names?: unknown } | null)?.names);

test("a kept page is read back by the next page, and the server's answer replaces it", () => {
  const storage = new FakeStorage();
  const first = keptPage("test-a", 1, isList, () => storage);
  first.remember({ names: ["a"] });
  // A reload: a new page, the same storage.
  const again = keptPage("test-a", 1, isList, () => storage);
  // useKept reads it through a store; what a reader gets back is the same.
  assert.deepEqual(JSON.parse(storage.getItem("outrunner:page:test-a")!), { v: 1, value: { names: ["a"] } });
  again.remember({ names: ["b"] });
  assert.deepEqual(JSON.parse(storage.getItem("outrunner:page:test-a")!).value, { names: ["b"] });
});

test("one kept by an older build, or damaged, is dropped rather than shown", () => {
  const storage = new FakeStorage();
  storage.setItem("outrunner:page:test-b", JSON.stringify({ v: 0, value: { names: [] } }));
  keptPage("test-b", 1, isList, () => storage);
  assert.equal(storage.getItem("outrunner:page:test-b"), null);
  storage.setItem("outrunner:page:test-c", JSON.stringify({ v: 1, value: { names: "not a list" } }));
  keptPage("test-c", 1, isList, () => storage);
  assert.equal(storage.getItem("outrunner:page:test-c"), null);
});

test("a page too long to keep, or out of room, keeps nothing, and no older copy stands in", () => {
  const storage = new FakeStorage();
  const page = keptPage("test-d", 1, isList, () => storage);
  page.remember({ names: ["a"] });
  page.remember({ names: ["x".repeat(KEPT_PAGE_CHARS)] });
  assert.equal(storage.getItem("outrunner:page:test-d"), null);
  const small = new FakeStorage(10);
  keptPage("test-e", 1, isList, () => small).remember({ names: ["a", "b", "c"] });
  assert.equal(small.getItem("outrunner:page:test-e"), null);
});

test("the row made on Send is setting up, named from its prompt, on the branch it asks for", () => {
  const now = new Date("2026-10-29T10:00:00Z");
  const row = optimisticSession({
    id: "11111111-2222-4333-8444-555555555555",
    project: { id: "p1", defaultBranch: "main" },
    prompt: "\n  Fix the   login page\nand more",
    branch: "runtime/abc-11111111",
    agent: "claude",
    ownerId: "u1",
    provider: "daytona",
    now,
  });
  assert.equal(row.status, "creating");
  assert.equal(row.title, "Fix the login page");
  assert.equal(row.baseBranch, "main");
  assert.equal(row.branch, "runtime/abc-11111111");
  assert.equal(row.createdAt, now.toISOString());
  // A prompt of only attachments still has a label in the sidebar.
  assert.equal(optimisticSession({ ...row, project: { id: "p1", defaultBranch: "main" }, prompt: "", agent: "claude" }).title, "New session");
});

function workspace(id: string, updatedAt: string): Workspace {
  return { id, updatedAt, status: "ready", title: "Old" } as Workspace;
}

test("what this tab changed shows over rows read before it, and a row read since wins", () => {
  const since = Date.parse("2026-10-29T10:00:00Z");
  const before = workspace("a", "2026-10-29T09:59:00Z");
  const after = workspace("b", "2026-10-29T10:01:00Z");
  const shown = rowsAhead([before, after], {
    a: { patch: { status: "archiving" }, since },
    b: { patch: { status: "archiving" }, since },
  });
  assert.equal(shown[0].status, "archiving");
  assert.equal(shown[1], after);
  // Nothing ahead: the same list, so nothing downstream re-renders.
  const rows = [before];
  assert.equal(rowsAhead(rows, {}), rows);
});

test("a session being set up that the server hasn't placed is working", () => {
  const now = Date.parse("2026-10-29T10:00:00Z");
  assert.equal(fallbackStanding("2026-10-29T09:59:00Z", now, true).standing, "working");
  assert.equal(fallbackStanding("2026-10-29T09:59:00Z", now).standing, "done");
});

function message(role: "user" | "assistant", content: unknown[], timestamp = "2026-10-29T10:00:00Z"): AgentEvent {
  return { t: "message", uuid: `${role}-${timestamp}`, parentUuid: null, role, content, timestamp } as AgentEvent;
}

test("mid-turn, the indicator says what Claude is at, and since when", () => {
  assert.deepEqual(workingStep([message("user", [{ type: "text", text: "go" }], "t1")]), { label: "Thinking", since: "t1" });
  assert.deepEqual(
    workingStep([message("user", [{ type: "text", text: "go" }], "t1"), message("assistant", [{ type: "tool_use", id: "x", name: "Bash", input: {} }], "t2")]),
    { label: "Running Bash", since: "t2" },
  );
  // A tool's result: Claude is thinking about it.
  assert.equal(workingStep([message("user", [{ type: "tool_result", toolUseId: "x", content: "ok" }], "t3")]).label, "Thinking");
  assert.deepEqual(workingStep([]), { label: "Working", since: null });
});
