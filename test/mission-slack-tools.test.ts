/**
 * A Mission's Slack tools (lib/missions/slack-tools.ts): each reaches only a
 * thread of its own Mission, in the channel it's on call in now, never a
 * muted one, and queues its post under a stable key (said "queued"); a Ship
 * start on call is keyed (request_id, spawn_key) and reserved, with its place
 * and session id, before the session is made: retries find the same Ship, a
 * place comes back only when no Ship can have been made; and each start, and
 * each message to a Slack Ship, is checked again right before.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { QueuedPost } from "@/lib/missions/slack-outbox";
import type { MissionChannel, MissionRequest, MissionThread, SpawnReservation } from "@/lib/missions/slack-store";
import { askBlocks, parseAskValue } from "@/lib/missions/slack-text";
import { type MissionSlackDeps, refusalSaid } from "@/lib/missions/slack-tools";
import { callMissionTool, MISSION_TOOLS, type MissionToolDeps, type RunnerStart } from "@/lib/missions/tools";
import type { Workspace } from "@/lib/runtime/types";

function session(id: string, patch: Partial<Workspace> = {}): Workspace {
  return { id, kind: "session", status: "ready", ownerId: "alice", projectId: "p1", environmentId: "env1", parentMissionId: null, title: id, branch: `b/${id}`, ...patch } as Workspace;
}

function thread(id: string, missionId: string, ts: string, patch: Partial<MissionThread> = {}): MissionThread {
  return { id, missionId, teamId: "T1", channelId: "C1", threadTs: ts, permalink: `https://acme.slack.com/archives/C1/p${ts.replace(".", "")}`, startedBy: "ana", startedBySlack: "UANA", lastRequestTs: ts, muted: false, ...patch };
}

function channel(missionId: string, channelId: string, patch: Partial<MissionChannel> = {}): MissionChannel {
  return { missionId, orgId: "o1", teamId: "T1", channelId, boundBy: "wes", listen: "mentions", allowBotMessages: false, paused: false, revision: `rev-${missionId}`, ...patch };
}

type Ledger = { id: string; missionId: string; requestKey: string | null; spawnKey: string; threadId: string | null; plannedRunnerId: string; runnerId: string | null; requestedBy: string | null; revision: string };

/** m1 on call in C1, m2 in C2; m3 in none. m1's threads: t1 (two
 *  requests, by Ana then Bo), t3 muted, t4 of a channel it was on call in
 *  before. */
function world() {
  const sessions = [session("m1", { kind: "mission" }), session("m2", { kind: "mission" }), session("m3", { kind: "mission" })];
  const bindings: MissionChannel[] = [channel("m1", "C1"), channel("m2", "C2")];
  const threads = [
    thread("t1", "m1", "1731400000.000100"),
    thread("t2", "m2", "1731400000.000200", { channelId: "C2" }),
    thread("t3", "m1", "1731400000.000300", { muted: true }),
    thread("t4", "m1", "1731400000.000400", { channelId: "C9" }),
  ];
  const requests: MissionRequest[] = [
    { missionId: "m1", requestKey: "Ev1", threadId: "t1", bindingRevision: "rev-m1", messageTs: "1731400000.000100", requestedBy: "ana", requestedBySlack: "UANA" },
    { missionId: "m1", requestKey: "Ev2", threadId: "t1", bindingRevision: "rev-m1", messageTs: "1731400010.000100", requestedBy: "bo", requestedBySlack: "UBO" },
    { missionId: "m2", requestKey: "Ev9", threadId: "t2", bindingRevision: "rev-m2", messageTs: "1731400000.000200", requestedBy: "ana", requestedBySlack: "UANA" },
  ];
  const queue = new Map<string, QueuedPost>();
  /** Each queued post's status, as mission_slack_posts would have it. */
  const status = new Map<string, "pending" | "sent" | "failed" | "dropped" | "ambiguous">();
  const ledger: Ledger[] = [];
  const audits: string[] = [];
  const started: RunnerStart[] = [];
  const readers = new Set(["ana", "bo"]);
  const state = {
    perHour: 6,
    /** How the next startRunner goes. */
    next: "ok" as "ok" | "refused" | "throws" | "unknown" | "made-then-unknown",
    /** Run just before startRunner: a change racing the start. */
    beforeStart: null as null | (() => void),
  };
  let n = 0;
  const slack: MissionSlackDeps = {
    binding: async (missionId) => bindings.find((b) => b.missionId === missionId) ?? null,
    thread: async (missionId, ts) => threads.find((t) => t.missionId === missionId && t.threadTs === ts) ?? null,
    threadById: async (id) => threads.find((t) => t.id === id) ?? null,
    request: async (missionId, key) => requests.find((r) => r.missionId === missionId && r.requestKey === key) ?? null,
    latestRequest: async (threadId) => requests.filter((r) => r.threadId === threadId).at(-1) ?? null,
    canRead: async (userId) => readers.has(userId),
    // As queuePost: once a key; one failed or dropped queued again.
    queue: async (post) => {
      const was = status.get(post.opKey);
      if (was === "pending") return "already_pending";
      if (was === "sent") return "already_sent";
      if (was === "ambiguous") return "ambiguous";
      queue.set(post.opKey, post);
      status.set(post.opKey, "pending");
      return "queued";
    },
    saveAsk: async (input) => `00000000-0000-0000-0000-${String(queue.size).padStart(12, "0")}`.slice(0, 36) || input.opKey,
    askBlocks,
    // As reserve_mission_slack_spawn: the key's row, or a new one under the limits.
    reserveSpawn: async (input): Promise<SpawnReservation> => {
      const found = ledger.find((l) => l.missionId === input.missionId && l.requestKey === input.requestKey && l.spawnKey === input.spawnKey);
      if (found) return { id: found.id, plannedRunnerId: found.plannedRunnerId, runnerId: found.runnerId, existing: true };
      if (ledger.filter((l) => l.missionId === input.missionId).length >= state.perHour) return { refused: "hour", limit: state.perHour };
      const row: Ledger = {
        id: `s${ledger.length + 1}`,
        missionId: input.missionId,
        requestKey: input.requestKey,
        spawnKey: input.spawnKey,
        threadId: input.threadId,
        plannedRunnerId: `planned-${ledger.length + 1}`,
        runnerId: null,
        requestedBy: input.requester,
        revision: input.revision,
      };
      ledger.push(row);
      return { id: row.id, plannedRunnerId: row.plannedRunnerId, runnerId: null, existing: false };
    },
    linkShip: async (id, runnerId) => {
      ledger.find((l) => l.id === id)!.runnerId = runnerId;
    },
    releaseShip: async (id) => {
      const at = ledger.findIndex((l) => l.id === id && !l.runnerId);
      if (at >= 0) ledger.splice(at, 1);
    },
    ledger: async (runnerId) => {
      const row = ledger.find((l) => l.runnerId === runnerId);
      return row ? { requestKey: row.requestKey, requestedBy: row.requestedBy, bindingRevision: row.revision, thread: threads.find((t) => t.id === row.threadId) ?? null } : null;
    },
    auditShip: async (mission, _binding, request, runnerId) => {
      audits.push(`${mission.id}:${request?.requestKey ?? "-"}:${runnerId}`);
    },
    requesterName: async (request) => ({ name: request.requestedBySlack === "UBO" ? "Bo" : "Ana", permalink: "https://acme.slack.com/archives/C1/p1731400000000100" }),
  };
  const deps: MissionToolDeps = {
    access: async () => null,
    environmentReady: async () => null,
    session: async (id) => sessions.find((s) => s.id === id) ?? null,
    runners: async (missionId) => sessions.filter((s) => s.parentMissionId === missionId),
    working: async () => false,
    latestResponse: async () => null,
    pullRequests: async () => [],
    startRunner: async (mission, start) => {
      state.beforeStart?.();
      const how = state.next;
      state.next = "ok";
      if (how === "refused") return { error: "the plan's box limit", definite: true };
      if (how === "throws") throw new Error("socket hang up");
      if (how === "unknown") return { error: "Outrunner couldn't start it", definite: false };
      started.push(start);
      // The chosen id, or one of its own.
      const id = start.id ?? `r${++n}`;
      // As createCloudSession with a chosen id: made once, found after.
      if (!sessions.some((s) => s.id === id)) sessions.push(session(id, { parentMissionId: mission.id }));
      if (how === "made-then-unknown") return { error: "timed out", definite: false };
      return { runnerId: id };
    },
    send: async () => true,
    queue: async () => undefined,
    queued: async () => new Map(),
    archive: async () => true,
    readNotes: async () => ({ body: "", updatedAt: null }),
    writeNotes: async () => undefined,
    slack,
  };
  return { deps, queue, status, ledger, audits, started, state, bindings, threads, readers, sessions, requests };
}

const call = (deps: MissionToolDeps, missionId: string, name: string, args: Record<string, unknown>) => callMissionTool({ missionId }, name, args, deps);
const json = (text: string) => JSON.parse(text) as { runner_id: string; note: string };

test("the Slack tools and spawn_runner's keys are listed with the Mission's tools", () => {
  const names = MISSION_TOOLS.map((t) => t.name);
  for (const name of ["slack_reply", "slack_ask", "slack_react"]) assert.ok(names.includes(name), name);
  const props = MISSION_TOOLS.find((t) => t.name === "spawn_runner")!.inputSchema.properties as Record<string, unknown>;
  for (const key of ["request_id", "spawn_key", "thread"]) assert.ok(props[key], key);
});

test("a Mission queues posts only in its own threads of the channel it's on call in", async () => {
  const { deps, queue } = world();
  const own = await call(deps, "m1", "slack_reply", { thread: "1731400000.000100", text: "On **it**." });
  assert.equal(own.isError, undefined);
  assert.match(own.text, /^Queued/);
  const [post] = queue.values();
  assert.deepEqual(
    { ...post, opKey: post.opKey.replace(/:h:Ev2:[0-9a-f]+$/, ":h:Ev2:<hash>") },
    {
      opKey: "reply:m1:1731400000.000100:h:Ev2:<hash>",
      missionId: "m1",
      bindingRevision: "rev-m1",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1731400000.000100",
      kind: "reply",
      payload: { chunks: ["On *it*."] },
      // The thread's latest request's: Bo's access is checked before it goes.
      requester: "bo",
    },
  );
  for (const ts of ["1731400000.000200", "1731400000.000400", "1731400000.000999", "C2", "", undefined]) {
    for (const [name, args] of [
      ["slack_reply", { text: "x" }],
      ["slack_ask", { question: "q?", options: ["a"] }],
      ["slack_react", { emoji: "eyes" }],
    ] as const) {
      const result = await call(deps, "m1", name, { ...args, thread: ts });
      assert.equal(result.isError, true, `${name} ${ts}`);
      assert.match(result.text, /no such thread/, `${name} ${ts}`);
    }
  }
  assert.match((await call(deps, "m1", "slack_reply", { thread: "1731400000.000300", text: "x" })).text, /muted/);
  assert.equal((await call(deps, "m2", "slack_reply", { thread: "1731400000.000200", text: "Hi" })).isError, undefined);
  assert.equal((await call(deps, "m2", "slack_reply", { thread: "1731400000.000100", text: "Hi" })).isError, true);
  assert.match((await call(deps, "m3", "slack_reply", { thread: "1731400000.000100", text: "x" })).text, /isn't on call/);
  assert.deepEqual([...queue.values()].map((p) => `${p.channelId}/${p.threadTs}`), ["C1/1731400000.000100", "C2/1731400000.000200"]);
});

test("a tool call tried again is one post; post_key makes deliberate repeats distinct", async () => {
  const { deps, queue } = world();
  assert.match((await call(deps, "m1", "slack_reply", { thread: "1731400000.000100", text: "Done." })).text, /^Queued/);
  assert.match((await call(deps, "m1", "slack_reply", { thread: "1731400000.000100", text: "Done." })).text, /^Already queued/);
  assert.match((await call(deps, "m1", "slack_reply", { thread: "1731400000.000100", text: "Done.", post_key: "second" })).text, /^Queued/);
  assert.equal((await call(deps, "m1", "slack_reply", { thread: "1731400000.000100", text: "x", post_key: "no spaces" })).isError, true);
  assert.equal(queue.size, 2);
});

test("a post that failed or was dropped is queued again; one sent or ambiguous isn't, and the Mission is told which", async () => {
  const { deps, status } = world();
  const reply = () => call(deps, "m1", "slack_reply", { thread: "1731400000.000100", text: "Done." });
  await reply();
  const [key] = status.keys();
  for (const [was, said] of [
    ["failed", /^Queued/],
    ["dropped", /^Queued/],
    ["sent", /^Already posted/],
    ["ambiguous", /couldn't be told/],
  ] as const) {
    status.set(key, was);
    const result = await reply();
    assert.match(result.text, said, was);
    assert.equal(result.isError, was === "ambiguous" ? true : undefined, was);
  }
});

test("slack_react marks a request's own message: the one named, or the thread's latest", async () => {
  const { deps, queue } = world();
  await call(deps, "m1", "slack_react", { thread: "1731400000.000100", emoji: "eyes" });
  await call(deps, "m1", "slack_react", { thread: "1731400000.000100", emoji: "✅", request_id: "Ev1" });
  await call(deps, "m1", "slack_react", { thread: "1731400000.000100", emoji: "✅", request_id: "Ev1" });
  assert.equal((await call(deps, "m1", "slack_react", { thread: "1731400000.000100", emoji: "tada" })).isError, true);
  assert.equal((await call(deps, "m1", "slack_react", { thread: "1731400000.000100", emoji: "x", request_id: "Ev9" })).isError, true, "another Mission's request");
  assert.deepEqual(
    [...queue.values()].map((p) => p.payload),
    [
      { ts: "1731400010.000100", name: "eyes" },
      { ts: "1731400000.000100", name: "white_check_mark" },
    ],
  );
});

test("slack_ask queues a card with its options and Other, once", async () => {
  const { deps, queue } = world();
  const asked = await call(deps, "m1", "slack_ask", { thread: "1731400000.000100", question: "Which env?", options: ["staging", "prod", "staging"] });
  assert.match(asked.text, /^Queued: the question card/);
  assert.match((await call(deps, "m1", "slack_ask", { thread: "1731400000.000100", question: "Which env?", options: ["staging", "prod"] })).text, /^Already queued/);
  const [card] = queue.values();
  assert.equal(card.kind, "ask");
  const blocks = askBlocks("00000000-0000-0000-0000-0000000000aa", "Which env?", ["staging", "prod"]);
  assert.deepEqual((blocks[1] as { elements: { value: string }[] }).elements.map((e) => parseAskValue(e.value)?.option), [0, 1, "other"]);
  assert.equal((await call(deps, "m1", "slack_ask", { thread: "1731400000.000100", question: "q", options: [] })).isError, true);
});

test("spawn_runner on call: keyed by request, the requester in its brief, linked and audited", async () => {
  const { deps, ledger, audits, started } = world();
  const missing = await call(deps, "m1", "spawn_runner", { prompt: "Fix it.", request_id: "Ev1" });
  assert.match(missing.text, /spawn_key is required/);
  const result = await call(deps, "m1", "spawn_runner", { prompt: "Fix the login bug.", request_id: "Ev1", spawn_key: "fix-login" });
  assert.equal(result.isError, undefined);
  assert.equal(json(result.text).runner_id, "planned-1", "made with the session id its reservation chose");
  assert.deepEqual(
    ledger.map((l) => [l.requestKey, l.spawnKey, l.threadId, l.runnerId, l.requestedBy]),
    [["Ev1", "fix-login", "t1", "planned-1", "ana"]],
  );
  assert.deepEqual(audits, ["m1:Ev1:planned-1"]);
  assert.match(started[0].brief, /^Fix the login bug\.\n\n---\nRequested in Slack by Ana \(https:\/\/acme\.slack\.com/);
  // The thread form names its latest request: Bo's.
  await call(deps, "m1", "spawn_runner", { prompt: "And the docs.", thread: "1731400000.000100", spawn_key: "docs" });
  assert.deepEqual(ledger.at(-1)?.requestKey, "Ev2");
  assert.match(started[1].brief, /Requested in Slack by Bo/);
  // Another Mission's request, or a key with spaces: refused, nothing reserved.
  assert.match((await call(deps, "m1", "spawn_runner", { prompt: "x", request_id: "Ev9", spawn_key: "k" })).text, /no such request/);
  assert.equal((await call(deps, "m1", "spawn_runner", { prompt: "x", request_id: "Ev1", spawn_key: "a b" })).isError, true);
  assert.equal(ledger.length, 2);
});

test("a retry with the same key returns the same Ship; a new key starts another", async () => {
  const { deps, started, ledger } = world();
  const args = { prompt: "Fix the login bug.", request_id: "Ev1", spawn_key: "fix-login" };
  const first = json((await call(deps, "m1", "spawn_runner", args)).text);
  const again = json((await call(deps, "m1", "spawn_runner", args)).text);
  assert.equal(again.runner_id, first.runner_id);
  assert.match(again.note, /same one/);
  const other = json((await call(deps, "m1", "spawn_runner", { ...args, spawn_key: "fix-login-tests" })).text);
  assert.notEqual(other.runner_id, first.runner_id);
  // The same key for another request is another Ship.
  const forBo = json((await call(deps, "m1", "spawn_runner", { ...args, request_id: "Ev2" })).text);
  assert.notEqual(forBo.runner_id, first.runner_id);
  assert.equal(started.length, 3);
  assert.equal(ledger.length, 3);
});

test("a start whose outcome is unknown keeps its place; the retry finds the Ship it made", async () => {
  const { deps, state, ledger, started } = world();
  const args = { prompt: "Fix it.", request_id: "Ev1", spawn_key: "fix" };
  // The session was made, but the answer was lost (a timeout): no refund.
  state.next = "made-then-unknown";
  const lost = await call(deps, "m1", "spawn_runner", args);
  assert.equal(lost.isError, true);
  assert.match(lost.text, /same request_id and spawn_key/);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].runnerId, null);
  // Tried again: that Ship, linked, and no second start.
  const retry = json((await call(deps, "m1", "spawn_runner", args)).text);
  assert.equal(retry.runner_id, "planned-1");
  assert.equal(ledger[0].runnerId, "planned-1");
  assert.equal(started.length, 1);
});

test("a start that threw, or crashed before making anything, is resumed with the same session id", async () => {
  const { deps, state, ledger, started } = world();
  const args = { prompt: "Fix it.", request_id: "Ev1", spawn_key: "fix" };
  state.next = "throws";
  assert.equal((await call(deps, "m1", "spawn_runner", args)).isError, true);
  state.next = "unknown";
  assert.equal((await call(deps, "m1", "spawn_runner", args)).isError, true);
  assert.equal(ledger.length, 1, "the place stays: a timeout is no proof");
  const done = json((await call(deps, "m1", "spawn_runner", args)).text);
  assert.equal(done.runner_id, "planned-1");
  assert.deepEqual(started.map((s) => s.id), ["planned-1"]);
});

test("a refused start gives its place back, only when this call took it and no Ship exists", async () => {
  const { deps, state, ledger } = world();
  state.next = "refused";
  const refused = await call(deps, "m1", "spawn_runner", { prompt: "x", request_id: "Ev1", spawn_key: "a" });
  assert.match(refused.text, /plan's box limit/);
  assert.equal(ledger.length, 0);
  // A resumed reservation is never given back: an earlier call may still be
  // making its Ship.
  state.next = "unknown";
  await call(deps, "m1", "spawn_runner", { prompt: "x", request_id: "Ev1", spawn_key: "b" });
  state.next = "refused";
  await call(deps, "m1", "spawn_runner", { prompt: "x", request_id: "Ev1", spawn_key: "b" });
  assert.deepEqual(ledger.map((l) => l.spawnKey), ["b"]);
});

test("a Ship the platform refuses (the plan's cloud sessions, say) is said in the thread by the server, once; an unknown outcome says nothing", async () => {
  const { deps, state, queue } = world();
  state.next = "refused";
  const args = { prompt: "x", request_id: "Ev1", spawn_key: "a" };
  await call(deps, "m1", "spawn_runner", args);
  await call(deps, "m1", "spawn_runner", args);
  const posts = [...queue.values()].filter((p) => p.opKey.startsWith("refused:"));
  assert.equal(posts.length, 1, "the post is keyed by the reservation, so a repeat of it is one post");
  assert.equal(posts[0].threadTs, "1731400000.000100");
  assert.equal(posts[0].kind, "card");
  assert.match((posts[0].payload as { chunks: string[] }).chunks[0], /A Ship couldn't start for this request\. Outrunner couldn't start it right now\./);
  const before = queue.size;
  state.next = "unknown";
  await call(deps, "m1", "spawn_runner", { ...args, spawn_key: "c" });
  assert.equal(queue.size, before, "a start that may have worked says nothing: it's retried");
});

test("what Slack is told of a refused Ship is fixed per kind, and never carries the platform's own words or any dollar figure", () => {
  const refusals = [
    "Your plan's 2 concurrent cloud sessions are already running. End one to free its box (idle boxes pause within 15 minutes), or upgrade for more.",
    "The Pro plan's $20.00 of cloud usage is used up for this period. It starts again next period.",
    "The org's usage limit of $150.00 is reached for this period. An admin can raise it in Settings → Org → Usage.",
    "The free trial's $100.00 of cloud usage is used up. Subscribe to keep going.",
    "An overage payment failed. Pay it in Settings → Org → Billing to start new sessions.",
    "the plan's box limit",
  ];
  const said = refusals.map(refusalSaid);
  assert.deepEqual(said.slice(0, 1), ["The Mission owner's plan has no room for another cloud session right now."]);
  assert.deepEqual(new Set(said), new Set(["The Mission owner's plan has no room for another cloud session right now.", "The Mission owner's cloud usage is used up for now.", "Outrunner couldn't start it right now."]));
  for (const text of said) assert.doesNotMatch(text, /\$|\d/);
});

test("limits: one reached is told in the thread (queued, once) and starts nothing; existing keys still answer", async () => {
  const { deps, ledger, started, queue, state } = world();
  state.perHour = 2;
  await call(deps, "m1", "spawn_runner", { prompt: "a", request_id: "Ev1", spawn_key: "a" });
  // No request: counted all the same.
  await call(deps, "m1", "spawn_runner", { prompt: "b", spawn_key: "b" });
  const third = await call(deps, "m1", "spawn_runner", { prompt: "c", request_id: "Ev1", spawn_key: "c" });
  assert.match(third.text, /limit on Ships started while on call \(2 in an hour\)/);
  await call(deps, "m1", "spawn_runner", { prompt: "c", request_id: "Ev1", spawn_key: "c" });
  assert.equal(started.length, 2);
  assert.equal(ledger.length, 2);
  const told = [...queue.values()].filter((p) => p.opKey.startsWith("limit:"));
  assert.equal(told.length, 1);
  assert.match((told[0].payload as { chunks: string[] }).chunks[0], /I've started 2 Ships for this channel in the last hour/);
  // At the limit, the key already used still returns its Ship.
  assert.equal(json((await call(deps, "m1", "spawn_runner", { prompt: "a", request_id: "Ev1", spawn_key: "a" })).text).runner_id, "planned-1");
  // m3 isn't on call: no key, no limit.
  assert.equal((await call(deps, "m3", "spawn_runner", { prompt: "free" })).isError, undefined);
});

test("rechecked right before the start: unbound, rebound, paused, muted or the requester's access gone", async () => {
  const cases: [string, (w: ReturnType<typeof world>) => void, RegExp][] = [
    ["unbound", (w) => w.bindings.splice(0, 1), /no longer on call/],
    ["rebound", (w) => (w.bindings[0] = { ...w.bindings[0], revision: "rev-new" }), /put on call again/],
    ["paused", (w) => (w.bindings[0] = { ...w.bindings[0], paused: true }), /paused/],
    ["muted", (w) => (w.threads[0].muted = true), /muted/],
    ["access", (w) => w.readers.delete("ana"), /can no longer read/],
  ];
  for (const [name, change, why] of cases) {
    // Before the reservation: refused, nothing reserved.
    const before = world();
    change(before);
    const early = await call(before.deps, "m1", "spawn_runner", { prompt: "x", request_id: "Ev1", spawn_key: "k" });
    assert.equal(early.isError, true, name);
    assert.equal(before.ledger.length, 0, name);
    // Between the reservation and the start: refused, the place given back.
    const racing = world();
    const realReserve = racing.deps.slack!.reserveSpawn;
    racing.deps.slack!.reserveSpawn = async (input) => {
      const made = await realReserve(input);
      change(racing);
      return made;
    };
    const late = await call(racing.deps, "m1", "spawn_runner", { prompt: "x", request_id: "Ev1", spawn_key: "k" });
    assert.match(late.text, why, name);
    assert.equal(racing.started.length, 0, name);
    assert.equal(racing.ledger.length, 0, name);
  }
});

test("a request from before a rebind can't start a Ship under the new binding", async () => {
  const { deps, bindings, ledger } = world();
  bindings[0] = { ...bindings[0], revision: "rev-new" };
  assert.match((await call(deps, "m1", "spawn_runner", { prompt: "x", request_id: "Ev1", spawn_key: "k" })).text, /before the Mission was put on call again/);
  assert.equal(ledger.length, 0);
});

test("message_runner to a Slack Ship: rechecked against its binding and requester; paused or muted still goes", async () => {
  const w = world();
  const ship = json((await call(w.deps, "m1", "spawn_runner", { prompt: "x", request_id: "Ev1", spawn_key: "k" })).text).runner_id;
  const say = () => call(w.deps, "m1", "message_runner", { runner_id: ship, message: "go on" });
  w.bindings[0] = { ...w.bindings[0], paused: true };
  w.threads[0].muted = true;
  assert.equal((await say()).isError, undefined, "paused and muted: work already started goes on");
  w.readers.delete("ana");
  assert.match((await say()).text, /can no longer read/);
  w.readers.add("ana");
  w.bindings[0] = { ...w.bindings[0], revision: "rev-new" };
  assert.match((await say()).text, /binding that has ended/);
  // A Ship not started for Slack isn't held to any of it.
  const own = json((await call(w.deps, "m3", "spawn_runner", { prompt: "y" })).text).runner_id;
  assert.equal((await call(w.deps, "m3", "message_runner", { runner_id: own, message: "hi" })).isError, undefined);
});
