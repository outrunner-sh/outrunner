import assert from "node:assert/strict";
import { test } from "node:test";

import { KEPT_PAGE_CHARS, keptPage } from "@/lib/client/kept-page";
import { fallbackStanding } from "@/lib/nav/status-groups";
import { viewerScope } from "@/lib/orgs/active";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { workingStep } from "@/lib/runtime/conversation-events";
import type { Workspace } from "@/lib/runtime/types";
import {
  FAILED_CREATE,
  optimisticSession,
  sendingAgain,
  takeFailedAttachments,
  UNSENT_REUSED_FOR_MS,
} from "@/lib/session/pending-sessions";
import { rowsAhead } from "@/lib/session/rows-ahead";
import { sendCreate } from "@/lib/session/send-create";

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

test("a kept page is read back by the next page, under whose view it was, and the server's answer replaces it", () => {
  const storage = new FakeStorage();
  keptPage("test-a", 1, isList, () => storage).remember({ names: ["a"] }, "u1:org1");
  // A reload: a new page, the same storage.
  assert.deepEqual(JSON.parse(storage.getItem("outrunner:page:test-a")!), { v: 1, scope: "u1:org1", value: { names: ["a"] } });
  keptPage("test-a", 1, isList, () => storage).remember({ names: ["b"] }, "u1:org1");
  assert.deepEqual(JSON.parse(storage.getItem("outrunner:page:test-a")!).value, { names: ["b"] });
});

test("one kept by an older build, unscoped, or damaged, is dropped rather than shown", () => {
  const storage = new FakeStorage();
  storage.setItem("outrunner:page:test-b", JSON.stringify({ v: 0, scope: "u1:org1", value: { names: [] } }));
  keptPage("test-b", 1, isList, () => storage);
  assert.equal(storage.getItem("outrunner:page:test-b"), null);
  storage.setItem("outrunner:page:test-c", JSON.stringify({ v: 1, scope: "u1:org1", value: { names: "not a list" } }));
  keptPage("test-c", 1, isList, () => storage);
  assert.equal(storage.getItem("outrunner:page:test-c"), null);
  storage.setItem("outrunner:page:test-f", JSON.stringify({ v: 1, value: { names: [] } }));
  keptPage("test-f", 1, isList, () => storage);
  assert.equal(storage.getItem("outrunner:page:test-f"), null);
});

test("a page too long to keep, or out of room, keeps nothing, and no older copy stands in", () => {
  const storage = new FakeStorage();
  const page = keptPage("test-d", 1, isList, () => storage);
  page.remember({ names: ["a"] }, "u1:org1");
  page.remember({ names: ["x".repeat(KEPT_PAGE_CHARS)] }, "u1:org1");
  assert.equal(storage.getItem("outrunner:page:test-d"), null);
  const small = new FakeStorage(10);
  keptPage("test-e", 1, isList, () => small).remember({ names: ["a", "b", "c"] }, "u1:org1");
  assert.equal(small.getItem("outrunner:page:test-e"), null);
});

test("another viewer's kept page is never theirs to see", () => {
  assert.equal(viewerScope("u1", "org1"), "u1:org1");
  assert.notEqual(viewerScope("u2", "org1"), viewerScope("u1", "org1"));
  assert.notEqual(viewerScope("u1", "org2"), viewerScope("u1", "org1"));
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

test("a change shows over the row it was made over, and a row the server wrote since wins", () => {
  const before = workspace("a", "2026-10-29T09:59:00Z");
  const written = workspace("b", "2026-10-29T10:01:00Z");
  // Made over rows last written at 09:59; the browser's clock doesn't enter into it.
  const held = { patch: { status: "archiving" as const }, over: "2026-10-29T09:59:00Z", since: 0 };
  const shown = rowsAhead([before, written], { a: held, b: held }, 1);
  assert.equal(shown[0].status, "archiving");
  assert.equal(shown[1], written);
  // Nothing ahead: the same list, so nothing downstream re-renders.
  const rows = [before];
  assert.equal(rowsAhead(rows, {}, 0), rows);
});

test("a change to a session the list didn't have shows until a list arrives after it", () => {
  const row = workspace("new", "2026-10-29T10:00:05Z");
  const held = { patch: { title: "Named" }, over: null, since: 1_000 };
  // A list that arrived before the change, by this tab's clock: the change shows.
  assert.equal(rowsAhead([row], { new: held }, 900)[0].title, "Named");
  // One that arrived after it is the server's word.
  assert.equal(rowsAhead([row], { new: held }, 1_100)[0].title, "Old");
});

test("a session being set up that the server hasn't placed is working", () => {
  const now = Date.parse("2026-10-29T10:00:00Z");
  assert.equal(fallbackStanding("2026-10-29T09:59:00Z", now, true).standing, "working");
  assert.equal(fallbackStanding("2026-10-29T09:59:00Z", now).standing, "backlog");
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

test("a create whose answer is lost is sent again, the same, until one gets through", async () => {
  const bodies: string[] = [];
  let calls = 0;
  const flaky = (async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body));
    if (++calls < 3) throw new TypeError("network");
    return new Response("{}", { status: 202 });
  }) as typeof fetch;
  const waited: number[] = [];
  const response = await sendCreate("/api/projects/p/workspaces", '{"id":"x"}', flaky, async (ms) => {
    waited.push(ms);
  });
  assert.equal(response?.status, 202);
  // The same body each time: the server settles which send made the session.
  assert.deepEqual(bodies, ['{"id":"x"}', '{"id":"x"}', '{"id":"x"}']);
  assert.deepEqual(waited, [1_000, 2_000]);
  // None got through at all: null, after every resend.
  const down = (async () => {
    throw new TypeError("network");
  }) as typeof fetch;
  assert.equal(await sendCreate("/u", "{}", down, async () => {}), null);
});

test("a lost create is sent again as itself only when the same request follows soon after", () => {
  const unsent = { id: "s1", branch: "runtime/a-s1", projectId: "p1", request: '["outrunner","glm",null,null]', at: 1_000 };
  assert.equal(sendingAgain(unsent, "p1", unsent.request, 2_000), unsent);
  // Another repository, another model, or much later: a new session.
  assert.equal(sendingAgain(unsent, "p2", unsent.request, 2_000), null);
  assert.equal(sendingAgain(unsent, "p1", '["claude","opus",null,null]', 2_000), null);
  assert.equal(sendingAgain(unsent, "p1", unsent.request, 1_000 + UNSENT_REUSED_FOR_MS), null);
  assert.equal(sendingAgain(null, "p1", unsent.request, 2_000), null);
});

test("a refused create's files are given back once, then are the composer's", () => {
  FAILED_CREATE.set({ prompt: "p", attachmentIds: ["a1"], message: "no", action: null });
  takeFailedAttachments();
  assert.deepEqual(FAILED_CREATE.get()?.attachmentIds, []);
  // The prompt and the reason stay for the screen to say.
  assert.equal(FAILED_CREATE.get()?.message, "no");
  FAILED_CREATE.set(null);
});
