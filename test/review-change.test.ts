import assert from "node:assert/strict";
import { test } from "node:test";

import {
  changeDone,
  type ChangeDeps,
  type ChangeRequest,
  changePrompt,
  type LineQuote,
  type ReviewThread,
  requestChange,
  startSoon,
  threadsOn,
  toReviewThreads,
} from "@/lib/review/change";
import type { ServerSessionStart } from "@/lib/session/server-session";

const quote: LineQuote = { path: "lib/a.ts", side: "new", startLine: 10, endLine: 14, code: "const a = 1;" };

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "PRRT_1",
  path: "lib/a.ts",
  side: "new",
  startLine: 12,
  endLine: 12,
  resolved: false,
  comments: [{ id: 501, author: "bob", body: "Name this better.", url: "https://github.com/acme/repo/pull/7#discussion_r501" }],
  ...over,
});

const request = (over: Partial<ChangeRequest> = {}): ChangeRequest => ({
  pull: {
    repo: "acme/repo",
    projectId: "p1",
    number: 7,
    title: "Add a",
    url: "https://github.com/acme/repo/pull/7",
    headRef: "feature/a",
    baseRef: "main",
    fromFork: false,
  },
  userId: "u1",
  login: "alice",
  level: "write",
  orgId: "o1",
  message: "Rename a to count.",
  quote,
  ...over,
});

test("only open threads on the picked lines count", () => {
  const threads = [
    thread(),
    thread({ id: "resolved", resolved: true }),
    thread({ id: "other-file", path: "lib/b.ts" }),
    thread({ id: "old-side", side: "old" }),
    thread({ id: "above", startLine: 1, endLine: 9 }),
    thread({ id: "overlaps", startLine: 14, endLine: 20 }),
    thread({ id: "empty", comments: [] }),
  ];
  assert.deepEqual(
    threadsOn(threads, quote).map((t) => t.id),
    ["PRRT_1", "overlaps"],
  );
  assert.deepEqual(threadsOn(threads, null), []);
});

test("GitHub's review threads are read, outdated ones left out", () => {
  const threads = toReviewThreads([
    {
      id: "PRRT_a",
      isResolved: false,
      path: "lib/a.ts",
      diffSide: "RIGHT",
      line: 14,
      startLine: 12,
      comments: { nodes: [{ databaseId: 9, author: { login: "bob" }, body: "Hm", url: "u" }, { author: null }] },
    },
    { id: "PRRT_b", isResolved: true, path: "lib/a.ts", diffSide: "LEFT", line: 3, startLine: null, comments: { nodes: [] } },
    { id: "PRRT_outdated", path: "lib/a.ts", line: null },
  ]);
  assert.deepEqual(threads, [
    { id: "PRRT_a", path: "lib/a.ts", side: "new", startLine: 12, endLine: 14, resolved: false, comments: [{ id: 9, author: "bob", body: "Hm", url: "u" }] },
    { id: "PRRT_b", path: "lib/a.ts", side: "old", startLine: 3, endLine: 3, resolved: true, comments: [] },
  ]);
});

test("the prompt says what, where, and how to answer the review comments", () => {
  const prompt = changePrompt(request(), [thread()], false);
  assert.match(prompt, /@alice asked for a change from Outrunner's Review page, on pull request acme\/repo#7 "Add a"/);
  assert.match(prompt, /> Rename a to count\./);
  assert.match(prompt, /On `lib\/a\.ts`, lines 10-14:\n```\nconst a = 1;\n```/);
  assert.match(prompt, /Thread `PRRT_1`, started by @bob .*first comment id 501/);
  assert.match(prompt, /git push origin HEAD:feature\/a/);
  assert.match(prompt, /pulls\/7\/comments\/<first comment id>\/replies/);
  assert.match(prompt, /resolveReviewThread/);
  assert.doesNotMatch(prompt, /working tree starts/);
  assert.match(prompt, /Never write "@outrunner"/);

  const bare = changePrompt(request({ quote: null }), [], true);
  assert.doesNotMatch(bare, /resolveReviewThread/);
  assert.doesNotMatch(bare, /```/);
  assert.match(bare, /working tree starts at the pull request's head branch, `feature\/a`/);
});

function deps(over: Partial<ChangeDeps> & { sessions?: { id: string; ownerId: string; status: string }[] } = {}) {
  const calls: string[] = [];
  const started: ServerSessionStart[] = [];
  const d: ChangeDeps = {
    linkedSessions: async () => over.sessions ?? [],
    reviewThreads: async () => [thread()],
    wakeAndSend: async (ownerId, id) => {
      calls.push(`send:${ownerId}:${id}`);
      return true;
    },
    startSession: async (start) => {
      started.push(start);
      await start.onCreated?.("new-session");
      return { workspaceId: "new-session" };
    },
    link: async (link, ws) => {
      calls.push(`link:${link.number}:${ws.id}:${ws.ownerId}`);
    },
    humanSpoke: async () => {
      calls.push("spoke");
    },
    ...over,
  };
  return { d, calls, started };
}

test("the asker's own session on the PR takes the change", async () => {
  const { d, calls } = deps({ sessions: [{ id: "s1", ownerId: "u1", status: "ready" }] });
  assert.deepEqual(await requestChange(request({ level: "read" }), d), { kind: "sent", sessionId: "s1", ownerId: "u1", threads: 1 });
  assert.deepEqual(calls, ["send:u1:s1", "spoke"]);
});

test("a teammate's session takes it from someone who may write, not from a reader", async () => {
  const sessions = [{ id: "s2", ownerId: "teammate", status: "suspended" }];
  const writer = deps({ sessions });
  assert.equal((await requestChange(request({ level: "write" }), writer.d)).kind, "sent");
  assert.deepEqual(writer.calls, ["send:teammate:s2", "spoke"]);

  const reader = deps({ sessions });
  const outcome = await requestChange(request({ level: "read" }), reader.d);
  assert.deepEqual(outcome, { kind: "started", sessionId: "new-session", ownerId: "u1", threads: 1 });
  assert.deepEqual(reader.calls, ["spoke", "link:7:new-session:u1"]);
  assert.equal(reader.started[0].baseBranch, "feature/a");
  assert.equal(reader.started[0].userId, "u1");
  assert.match(reader.started[0].prompt, /working tree starts/);
});

test("a session that can't take it gives way to a new one", async () => {
  const { d, started } = deps({ sessions: [{ id: "s1", ownerId: "u1", status: "ready" }], wakeAndSend: async () => false });
  assert.equal((await requestChange(request(), d)).kind, "started");
  assert.equal(started.length, 1);
});

test("a fork's PR, or someone who can't read the repository, is refused", async () => {
  const fork = deps();
  const refused = await requestChange(request({ pull: { ...request().pull, fromFork: true } }), fork.d);
  assert.equal(refused.kind, "refused");
  assert.equal(fork.started.length, 0);
  assert.equal((await requestChange(request({ level: null }), deps().d)).kind, "refused");
});

test("threads that can't be read don't stop the change", async () => {
  const { d } = deps({ reviewThreads: async () => Promise.reject(new Error("no")) });
  assert.deepEqual(await requestChange(request(), d), { kind: "started", sessionId: "new-session", ownerId: "u1", threads: 0 });
});

test("startSoon answers once the session's row is made, leaving its setup to go on", async () => {
  let finish: () => void = () => undefined;
  let rest: Promise<unknown> | null = null;
  const linked: string[] = [];
  const start = startSoon(
    (s) =>
      new Promise((resolve) => {
        void s.onCreated?.("ws-1");
        finish = () => resolve({ workspaceId: "ws-1", status: "ready" } as never);
      }),
    (r) => {
      rest = r;
    },
  );
  const made = await start({
    userId: "u1",
    projectId: "p1",
    title: "t",
    prompt: "p",
    source: "github",
    onCreated: async (id) => {
      linked.push(id);
    },
  });
  assert.deepEqual(made, { workspaceId: "ws-1" });
  assert.deepEqual(linked, ["ws-1"]);
  assert.ok(rest);
  finish();
  await rest;

  const refused = startSoon(async () => ({ workspaceId: null, status: "refused", errorMessage: "Out of hours." }), () => undefined);
  assert.deepEqual(await refused({ userId: "u1", projectId: "p1", title: "t", prompt: "p", source: "github" }), { refused: "Out of hours." });
});

test("a change is done once the session replied after it was asked and stopped working", () => {
  const askedAt = "2026-10-29T10:00:00.000Z";
  assert.equal(changeDone({ working: false, status: "ready", repliedAt: "2026-10-29T10:05:00.123456+00:00" }, askedAt), true);
  assert.equal(changeDone({ working: true, status: "ready", repliedAt: "2026-10-29T10:05:00.000Z" }, askedAt), false);
  assert.equal(changeDone({ working: false, status: "ready", repliedAt: "2026-10-29T09:00:00.000Z" }, askedAt), false);
  assert.equal(changeDone({ working: false, status: "provisioning", repliedAt: null }, askedAt), false);
});
