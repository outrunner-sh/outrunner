/**
 * Slack → Mission → Ship → Slack, end to end through the real modules, with
 * a fake Slack and in-memory stores standing in for the database (whose SQL
 * test/mission-slack-sql.test.ts runs for real): a mention saved before the
 * answer, its processor crashing and the tick finishing it; routed to the
 * Mission's outbox and delivered as a <slack_request>; the Mission's tool
 * calls (an acknowledgement, a reaction, a spawn whose answer is lost and is
 * retried); the queued posts sent with one send lost in flight; and the
 * Ship's pull request cards in the thread. Every message lands once, in
 * order.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { eventKey, type MissionEvent, parseRunnerEvents } from "@/lib/missions/events";
import { deliverMissionEvents } from "@/lib/missions/outbox";
import { announcePullRequest, announceShipEvent } from "@/lib/missions/slack-announce";
import { acceptInbound, processInbound } from "@/lib/missions/slack-inbound";
import { type ClaimedPost, deliverPost, type QueuedPost } from "@/lib/missions/slack-outbox";
import { routeToMission, type SlackRouteDeps } from "@/lib/missions/slack-route";
import type { MissionChannel, MissionRequest, MissionThread } from "@/lib/missions/slack-store";
import { askBlocks } from "@/lib/missions/slack-text";
import { callMissionTool, type MissionToolDeps } from "@/lib/missions/tools";
import type { Workspace } from "@/lib/runtime/types";
import type { AgentMessage } from "@/lib/slack/agent-run";
import { SlackUnknownOutcomeError } from "@/lib/slack/web";

test("a mention becomes a Ship and its pull request's cards, once each, through crashes and lost answers", async () => {
  // --- The world: a Mission on call in C1, Ana linked with read. ---
  const BOT = "UBOT";
  const binding: MissionChannel = { missionId: "m1", orgId: "o1", teamId: "T1", channelId: "C1", boundBy: "wes", listen: "mentions", allowBotMessages: false, paused: false, revision: "rev1" };
  const sessions: Workspace[] = [{ id: "m1", kind: "mission", status: "ready", ownerId: "owner", projectId: "p1", environmentId: "env1", title: "On call: web", branch: "b" } as Workspace];
  const threads: MissionThread[] = [];
  const requests: MissionRequest[] = [];
  const inbound = new Map<string, { message: AgentMessage; done: boolean; leased: boolean }>();
  const events: (MissionEvent & { key: string; delivered: boolean })[] = [];
  const posts: (QueuedPost & { id: string; status: string; attempt: number; progress: number; postedTs: string[]; inDoubt: boolean })[] = [];
  const ledger: { id: string; requestKey: string | null; spawnKey: string; threadId: string | null; planned: string; runnerId: string | null; requestedBy: string | null }[] = [];

  // --- A fake Slack: the channel's messages, with their markers. ---
  const slack: { ts: string; thread: string; text: string; marker: string }[] = [];
  const reactions: string[] = [];
  let loseNextSend = false;
  let tsClock = 1731400100;

  // --- Slack sends the mention. The endpoint saves it, then answers. ---
  const mention: AgentMessage = { teamId: "T1", channel: "C1", user: "UANA", text: `<@${BOT}> the login page 500s on Safari`, ts: "1731400000.000100", mention: true, eventId: "Ev1" };
  const inboundDeps = {
    binding: async () => binding,
    thread: async (_t: string, _c: string, ts: string) => threads.find((t) => t.threadTs === ts) ?? null,
    save: async (id: string, message: AgentMessage) => {
      if (inbound.has(id)) return false;
      inbound.set(id, { message, done: false, leased: false });
      return true;
    },
    claim: async (id: string) => {
      const row = inbound.get(id);
      if (!row || row.done || row.leased) return null;
      row.leased = true;
      return { message: row.message, attempt: 1 };
    },
    handle: async (message: AgentMessage) => {
      assert.equal(await routeToMission(message, routeDeps), true);
    },
    complete: async (id: string) => {
      inbound.get(id)!.done = true;
    },
    fail: async (id: string) => {
      inbound.get(id)!.leased = false;
    },
  };
  assert.equal(await acceptInbound("Ev1", mention, inboundDeps), "saved");
  // Slack retries (the answer was slow): the same row.
  assert.equal(await acceptInbound("Ev1", mention, inboundDeps), "duplicate");
  // The processor right after the answer dies holding it; its lease runs out.
  await inboundDeps.claim("Ev1");
  inbound.get("Ev1")!.leased = false;

  // --- The tick processes it: routed to the Mission. ---
  const routeDeps: SlackRouteDeps = {
    botUserId: BOT,
    binding: async () => binding,
    thread: async (_t, _c, ts) => threads.find((t) => t.threadTs === ts) ?? null,
    mission: async (id) => sessions.find((s) => s.id === id) ?? null,
    linked: async (user) => (user === "UANA" ? { userId: "ana", orgId: "o1" } : null),
    level: async (userId) => (userId === "ana" ? "read" : null),
    projectName: async () => "web",
    acceptThread: async (input) => {
      let thread = threads.find((t) => t.threadTs === input.threadTs);
      if (!thread) {
        thread = { id: "t1", missionId: input.missionId, teamId: "T1", channelId: "C1", threadTs: input.threadTs, permalink: input.permalink, startedBy: input.startedBy, startedBySlack: input.startedBySlack, lastRequestTs: input.requestTs, muted: false };
        threads.push(thread);
      }
      return thread;
    },
    recordRequest: async (request) => {
      if (!requests.some((r) => r.requestKey === request.requestKey)) requests.push(request);
    },
    setMuted: async () => undefined,
    setPaused: async () => undefined,
    unbind: async () => undefined,
    enqueue: async (event) => {
      if (events.some((e) => e.key === event.key)) return false;
      events.push({ id: `e${events.length + 1}`, runnerId: event.runnerId, kind: event.kind, payload: event.payload, createdAt: "2026-11-12T10:00:00Z", key: event.key, delivered: false });
      return true;
    },
    interrupt: async () => true,
    name: async () => "Ana",
    permalink: async (ts) => `https://acme.slack.com/archives/C1/p${ts.replace(".", "")}`,
    reply: async () => undefined,
    tell: async () => undefined,
    askToConnect: async () => undefined,
    findProject: async () => null,
    projectLevel: async () => null,
    localChannel: async () => true,
    freeMissions: async () => [],
    createMission: async () => ({ error: "unused" }),
    bind: async () => "bound",
    announce: async () => undefined,
  };
  assert.equal(await processInbound("Ev1", inboundDeps), "done");
  assert.equal(await processInbound("Ev1", inboundDeps), "busy", "processed once");
  assert.equal(events.length, 1);

  // --- The outbox delivers it to the Mission. ---
  const said: string[] = [];
  await deliverMissionEvents("m1", {
    claim: async () => (events.some((e) => !e.delivered) ? { deliveryId: "d1", attempt: 1 } : null),
    eventsOf: async () => events.filter((e) => !e.delivered),
    session: async () => sessions[0],
    send: async (_m, text) => {
      said.push(text);
    },
    complete: async () => {
      for (const e of events) e.delivered = true;
    },
    fail: async () => undefined,
  });
  const [request] = parseRunnerEvents(said[0]).events;
  assert.equal(request.kind, "slack_request");
  const requestId = /request_id="([^"]+)"/.exec(said[0])?.[1];
  const threadTs = /thread="([^"]+)"/.exec(said[0])?.[1];
  assert.equal(requestId, "Ev1");
  assert.equal(threadTs, "1731400000.000100");

  // --- The Mission works: its tools, wired to the same stores. ---
  let lostStart = true;
  const tools: MissionToolDeps = {
    access: async () => null,
    environmentReady: async () => null,
    session: async (id) => sessions.find((s) => s.id === id) ?? null,
    runners: async () => sessions.filter((s) => s.parentMissionId === "m1"),
    working: async () => false,
    latestResponse: async () => null,
    pullRequests: async () => [],
    startRunner: async (_m, start) => {
      if (!sessions.some((s) => s.id === start.id)) {
        sessions.push({ id: start.id!, kind: "session", status: "creating", ownerId: "owner", projectId: "p1", parentMissionId: "m1", title: start.name ?? "ship", branch: "fix-login" } as Workspace);
      }
      // The first call made the session, but its answer was lost.
      if (lostStart) {
        lostStart = false;
        return { error: "timed out", definite: false };
      }
      return { runnerId: start.id! };
    },
    send: async () => true,
    queue: async () => undefined,
    queued: async () => new Map(),
    archive: async () => true,
    readNotes: async () => ({ body: "", updatedAt: null }),
    writeNotes: async () => undefined,
    slack: {
      binding: async () => binding,
      thread: async (_m, ts) => threads.find((t) => t.threadTs === ts) ?? null,
      threadById: async (id) => threads.find((t) => t.id === id) ?? null,
      request: async (_m, key) => requests.find((r) => r.requestKey === key) ?? null,
      latestRequest: async (threadId) => requests.filter((r) => r.threadId === threadId).at(-1) ?? null,
      canRead: async (userId) => userId === "ana",
      queue: async (post) => {
        if (posts.some((p) => p.opKey === post.opKey)) return "already_pending";
        posts.push({ ...post, id: `p${posts.length + 1}`, status: "pending", attempt: 0, progress: 0, postedTs: [], inDoubt: false });
        return "queued";
      },
      saveAsk: async () => "00000000-0000-0000-0000-0000000000aa",
      askBlocks,
      reserveSpawn: async (input) => {
        const found = ledger.find((l) => l.requestKey === input.requestKey && l.spawnKey === input.spawnKey);
        if (found) return { id: found.id, plannedRunnerId: found.planned, runnerId: found.runnerId, existing: true };
        const row = { id: `s${ledger.length + 1}`, requestKey: input.requestKey, spawnKey: input.spawnKey, threadId: input.threadId, planned: `ship-${ledger.length + 1}`, runnerId: null, requestedBy: input.requester };
        ledger.push(row);
        return { id: row.id, plannedRunnerId: row.planned, runnerId: null, existing: false };
      },
      linkShip: async (id, runnerId) => {
        ledger.find((l) => l.id === id)!.runnerId = runnerId;
      },
      releaseShip: async () => undefined,
      ledger: async (runnerId) => {
        const row = ledger.find((l) => l.runnerId === runnerId);
        return row ? { requestKey: row.requestKey, requestedBy: row.requestedBy, bindingRevision: "rev1", thread: threads.find((t) => t.id === row.threadId) ?? null } : null;
      },
      auditShip: async () => undefined,
      requesterName: async () => ({ name: "Ana", permalink: null }),
    },
  };
  const call = (name: string, args: Record<string, unknown>) => callMissionTool({ missionId: "m1" }, name, args, tools);
  assert.match((await call("slack_reply", { thread: threadTs, text: "On it: a Ship is looking at the Safari 500." })).text, /^Queued/);
  // The agent retries the call (it didn't see the answer): one post.
  assert.match((await call("slack_reply", { thread: threadTs, text: "On it: a Ship is looking at the Safari 500." })).text, /^Already queued/);
  await call("slack_react", { thread: threadTs, emoji: "eyes", request_id: requestId });
  const spawn = { prompt: "Fix the Safari 500 on login.", request_id: requestId, spawn_key: "fix-login", name: "login-fix" };
  const lost = await call("spawn_runner", spawn);
  assert.equal(lost.isError, true);
  const retried = JSON.parse((await call("spawn_runner", spawn)).text) as { runner_id: string };
  assert.equal(retried.runner_id, "ship-1");
  assert.equal(sessions.filter((s) => s.parentMissionId === "m1").length, 1, "one Ship");

  // --- The Ship opens a pull request; it settles ready, then merges. ---
  const announce = {
    ledger: tools.slack!.ledger,
    binding: async () => binding,
    latestThread: async () => threads[0],
    latestRequest: tools.slack!.latestRequest,
    queue: tools.slack!.queue,
  };
  const pr = { repo: "acme/web", number: 7, url: "https://github.com/acme/web/pull/7", title: "Fix Safari login" };
  await announcePullRequest({ missionId: "m1", runnerId: "ship-1", kind: "opened", pr, ship: "login-fix" }, announce);
  await announceShipEvent({ missionId: "m1", runnerId: "ship-1", kind: "ready", payload: { runner: "login-fix", pr }, key: eventKey.decision("ship-1", pr, 1) }, announce);
  await announceShipEvent({ missionId: "m1", runnerId: "ship-1", kind: "merged", payload: { runner: "login-fix", pr }, key: eventKey.ended("merged", "ship-1", pr) }, announce);
  await announceShipEvent({ missionId: "m1", runnerId: "ship-1", kind: "merged", payload: { runner: "login-fix", pr }, key: eventKey.ended("merged", "ship-1", pr) }, announce);

  // --- The queue sends them, one send lost in flight. ---
  const outbox = {
    binding: async () => binding,
    muted: async () => false,
    mission: async () => sessions[0],
    canRead: async (userId: string) => userId === "ana",
    post: async (post: QueuedPost, message: { text: string; marker: string }) => {
      const ts = `${tsClock++}.000100`;
      slack.push({ ts, thread: post.threadTs ?? ts, text: message.text, marker: message.marker });
      if (loseNextSend) {
        loseNextSend = false;
        throw new SlackUnknownOutcomeError("chat.postMessage", new Error("timeout"));
      }
      return ts;
    },
    react: async (_p: QueuedPost, ts: string, name: string) => {
      reactions.push(`${ts}:${name}`);
    },
    markers: async () => ({ markers: new Map(slack.map((m) => [m.marker, m.ts])), complete: true }),
    progressed: async () => undefined,
  };
  loseNextSend = true;
  for (let round = 0; round < 3; round++) {
    for (const post of posts.filter((p) => p.status === "pending")) {
      post.attempt++;
      const outcome = await deliverPost(post satisfies ClaimedPost, outbox);
      if (outcome.status === "retry") Object.assign(post, { inDoubt: outcome.inDoubt, progress: outcome.progress, postedTs: outcome.postedTs });
      else post.status = outcome.status;
    }
  }

  assert.ok(posts.every((p) => p.status === "sent"));
  assert.deepEqual(
    slack.map((m) => m.text),
    [
      "On it: a Ship is looking at the Safari 500.",
      ":arrow_heading_up: Opened: <https://github.com/acme/web/pull/7|#7 Fix Safari login> (Ship login-fix)",
      ":white_check_mark: Ready for review: <https://github.com/acme/web/pull/7|#7 Fix Safari login> (Ship login-fix)",
      ":rocket: Merged: <https://github.com/acme/web/pull/7|#7 Fix Safari login> (Ship login-fix)",
    ],
    "each once, in order, the lost send not posted twice",
  );
  assert.ok(slack.every((m) => m.thread === "1731400000.000100"));
  assert.deepEqual(reactions, ["1731400000.000100:eyes"]);
});
