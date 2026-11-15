/**
 * `!new <task>`, `!assign @person` and `!help` in a Mission's channel, the
 * parts below the router (test/mission-slack-route.test.ts has the router's):
 * the exact parsing, and `!new`'s request (lib/missions/requests.ts): recorded,
 * root-posted through the post queue, and heard by the Mission as a
 * `slack_request` in that new thread once the post goes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatDelivery, type MissionEvent } from "@/lib/missions/events";
import { announceLate, newThreadRequest, onRootSettled, type RequestDeps } from "@/lib/missions/requests";
import type { QueuedPost } from "@/lib/missions/slack-outbox";
import type { MissionChannel, MissionRequest, MissionThread } from "@/lib/missions/slack-store";
import { assignTarget, newRequestRootText, newTask, threadKeyword } from "@/lib/missions/slack-text";
import type { RecordedEvent } from "@/lib/missions/watch";

test("the keywords and their arguments are exact", () => {
  assert.equal(threadKeyword("!help"), "help");
  assert.equal(threadKeyword("!HELP me"), "help");
  assert.equal(threadKeyword("!new fix it"), "new");
  assert.equal(threadKeyword("!assign <@U1>"), "assign");
  assert.equal(threadKeyword("please !assign <@U1>"), null);
  assert.equal(threadKeyword("!newest"), null);
  assert.equal(newTask("!new   fix the login bug  "), "fix the login bug");
  assert.equal(newTask("!new"), "");
  assert.equal(assignTarget("!assign <@U0ABC>"), "U0ABC");
  assert.equal(assignTarget("!assign <@W0ABC|pat> please"), "W0ABC");
  assert.equal(assignTarget("!assign"), null);
  assert.equal(assignTarget("!assign <@U1> <@U2>"), null);
  assert.equal(assignTarget("!assign <@U1> !mute"), null);
  assert.equal(assignTarget("!assign <#C1>"), null);
});

test("!new's root post names who asked, and can't ping the channel", () => {
  assert.equal(newRequestRootText("UALICE", "fix CI"), ":inbox_tray: New request from <@UALICE>: fix CI");
  const loud = newRequestRootText("UALICE", "tell <!channel> and <!subteam^S1|@oncall> and <!here>");
  assert.ok(!loud.includes("<!"), loud);
  assert.match(loud, /@channel and @oncall and @here/);
  assert.ok(newRequestRootText("U1", "x".repeat(700)).endsWith("…"));
});

const MISSION = "m1";

function world(bound = true) {
  const rows = new Map<string, MissionRequest & { messageTsSet?: string }>();
  const queued: QueuedPost[] = [];
  const events: RecordedEvent[] = [];
  const threads: MissionThread[] = [];
  const crash = { enqueue: false };
  const binding: MissionChannel = { missionId: MISSION, orgId: "o1", teamId: "T1", channelId: "C1", boundBy: "w", listen: "mentions", allowBotMessages: false, paused: false, revision: "rev1" };
  const deps: RequestDeps = {
    binding: async () => (bound ? binding : null),
    record: async (request) => {
      if (rows.has(request.requestKey)) return false;
      rows.set(request.requestKey, { ...request, status: "open", announcedAt: null });
      return true;
    },
    request: async (_m, key) => rows.get(key) ?? null,
    queue: async (post) => {
      if (queued.some((q) => q.opKey === post.opKey)) return "already_pending";
      queued.push(post);
      return "queued";
    },
    acceptThread: async (input) => {
      const known = threads.find((t) => t.threadTs === input.threadTs);
      if (known) return known;
      const thread = { id: `t${threads.length + 1}`, missionId: input.missionId, teamId: input.teamId, channelId: input.channelId, threadTs: input.threadTs, permalink: null, startedBy: input.startedBy, startedBySlack: null, lastRequestTs: input.threadTs, muted: false };
      threads.push(thread);
      return thread;
    },
    setThread: async (_m, key, threadId, messageTs) => {
      const row = rows.get(key)!;
      row.threadId = threadId;
      if (messageTs) row.messageTs = messageTs;
    },
    thread: async (id) => threads.find((t) => t.id === id) ?? null,
    markAnnounced: async (_m, key) => {
      const row = rows.get(key)!;
      if (row.announcedAt) return false;
      row.announcedAt = "now";
      return true;
    },
    cancel: async (_m, key) => {
      const row = rows.get(key)!;
      if (row.status === "cancelled") return false;
      row.status = "cancelled";
      return true;
    },
    openInThread: async (threadId) => [...rows.values()].filter((r) => r.threadId === threadId && r.status === "open"),
    pending: async () => [],
    enqueue: async (event) => {
      if (crash.enqueue) throw new Error("crashed");
      if (events.some((e) => e.key === event.key)) return false;
      events.push(event);
      return true;
    },
  };
  return { deps, rows, queued, events, threads, crash };
}

const input = { missionId: MISSION, key: "new:En", task: "deploy the docs", requestedBy: "alice", requestedBySlack: "UALICE", author: "Alice" };

test("!new: recorded with no thread, and its root post queued in the bound channel, once", async () => {
  const w = world();
  assert.equal(await newThreadRequest(input, w.deps), "queued");
  assert.equal(await newThreadRequest(input, w.deps), "queued", "a retry");
  assert.equal(w.queued.length, 1);
  const [root] = w.queued;
  assert.equal(root.kind, "root");
  assert.equal(root.threadTs, null);
  assert.equal(root.channelId, "C1");
  assert.equal(root.bindingRevision, "rev1");
  assert.equal(root.requester, "alice");
  assert.equal(root.requestKey, "new:En");
  assert.deepEqual(root.payload, { chunks: [":inbox_tray: New request from <@UALICE>: deploy the docs"] });
  const row = w.rows.get("new:En")!;
  assert.equal(row.source, "slack");
  assert.equal(row.threadId, null);
  assert.equal(row.messageTs, null);
  assert.deepEqual(row.details, { text: "deploy the docs", from: "Alice" });
  assert.equal(w.events.length, 0, "heard once its root post goes");
});

test("!new's root post went: its message is the request's thread, and the Mission hears a slack_request there, once", async () => {
  const w = world();
  await newThreadRequest(input, w.deps);
  const posted = { ...w.queued[0], requestKey: "new:En" };
  await onRootSettled(posted, "1731400500.000100", w.deps);
  await onRootSettled(posted, "1731400500.000100", w.deps);
  assert.equal(w.threads.length, 1);
  assert.equal(w.threads[0].threadTs, "1731400500.000100");
  assert.equal(w.threads[0].startedBy, "alice");
  const row = w.rows.get("new:En")!;
  assert.equal(row.threadId, "t1");
  assert.equal(row.messageTs, "1731400500.000100", "slack_react's message");
  assert.equal(w.events.length, 1);
  const [event] = w.events;
  assert.equal(event.kind, "slack_request");
  assert.equal(event.key, "slack_request:new:En");
  assert.deepEqual(event.payload.slack, {
    channel: "C1",
    thread: "1731400500.000100",
    request: "new:En",
    ts: "1731400500.000100",
    permalink: null,
    author: "Alice",
    slackUserId: "UALICE",
    userId: "alice",
    text: "deploy the docs",
  });
  const delivered = formatDelivery([{ ...(event as unknown as MissionEvent), id: "e1", createdAt: "2026-11-15T10:00:00Z" }]);
  assert.match(delivered, /^<slack_request thread="1731400500\.000100" request_id="new:En" from="Alice"/);
});

test("!new's root post failed: closed, untold; off call: nothing made", async () => {
  const w = world();
  await newThreadRequest(input, w.deps);
  await onRootSettled({ ...w.queued[0], requestKey: "new:En" }, null, w.deps);
  assert.equal(w.rows.get("new:En")?.status, "cancelled");
  assert.equal(w.events.length, 0);
  assert.equal(w.threads.length, 0);
  const v = world(false);
  assert.equal(await newThreadRequest(input, v.deps), "off_call");
  assert.equal(v.rows.size, 0);
  assert.equal(v.queued.length, 0);
});

test("!new: a crash after its root post settled, before the Mission heard: the tick tells it, once", async () => {
  const w = world();
  await newThreadRequest(input, w.deps);
  const root = { status: "sent", createdAt: "2026-11-15T10:00:00Z" };
  // Untold while its root post hasn't settled into a thread.
  assert.equal(await announceLate(w.rows.get("new:En")!, { status: "pending", createdAt: "2026-11-15T10:00:00Z" }, w.deps), false);
  w.crash.enqueue = true;
  await assert.rejects(onRootSettled({ ...w.queued[0], requestKey: "new:En" }, "1731400500.000100", w.deps));
  w.crash.enqueue = false;
  const row = w.rows.get("new:En")!;
  assert.equal(row.threadId, "t1");
  assert.equal(row.announcedAt, null);
  assert.equal(w.events.length, 0);
  // The tick.
  assert.equal(await announceLate(row, root, w.deps), true);
  assert.equal(w.events.length, 1);
  assert.equal(w.events[0].kind, "slack_request");
  assert.equal(w.events[0].payload.slack?.thread, "1731400500.000100");
  assert.equal(w.events[0].payload.slack?.request, "new:En");
  // The next tick: nothing more.
  assert.equal(await announceLate(w.rows.get("new:En")!, root, w.deps), false);
  assert.equal(w.events.length, 1);
});

test("the tick never tells a mention's request (told inline), nor a closed or threadless !new", async () => {
  const w = world();
  const mention: MissionRequest = { missionId: MISSION, requestKey: "Ev1", threadId: "t1", bindingRevision: "rev1", messageTs: "1731400000.000100", requestedBy: "alice", requestedBySlack: "UALICE", source: "slack", status: "open", announcedAt: null };
  w.threads.push({ id: "t1", missionId: MISSION, teamId: "T1", channelId: "C1", threadTs: "1731400000.000100", permalink: null, startedBy: "alice", startedBySlack: "UALICE", lastRequestTs: null, muted: false });
  assert.equal(await announceLate(mention, null, w.deps), false);
  const fresh = { ...mention, requestKey: "new:Ex", details: { text: "x", from: "Alice" } };
  assert.equal(await announceLate({ ...fresh, threadId: null }, null, w.deps), false);
  assert.equal(await announceLate({ ...fresh, status: "cancelled" }, null, w.deps), false);
  assert.equal(w.events.length, 0);
});
