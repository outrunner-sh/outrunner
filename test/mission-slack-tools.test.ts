/**
 * A Mission's Slack tools (lib/missions/slack-tools.ts): each reaches only a
 * thread of its own Mission, in the channel it's on call in now, never a
 * muted one; spawn_runner on a Mission on call is held to its limits (the
 * thread told when one is reached), linked to its thread, and audited; and a
 * Ship's pull request news is posted in its thread (slack-announce.ts).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { announceShipEvent, announceWaiting, type AnnounceDeps } from "@/lib/missions/slack-announce";
import type { MissionChannel, MissionThread } from "@/lib/missions/slack-store";
import { askBlocks, parseAskValue } from "@/lib/missions/slack-text";
import type { MissionSlackDeps } from "@/lib/missions/slack-tools";
import { callMissionTool, MISSION_TOOLS, type MissionToolDeps, type RunnerStart } from "@/lib/missions/tools";
import type { Workspace } from "@/lib/runtime/types";

function session(id: string, patch: Partial<Workspace> = {}): Workspace {
  return { id, kind: "session", status: "ready", ownerId: "alice", projectId: "p1", environmentId: "env1", parentMissionId: null, title: id, branch: `b/${id}` , ...patch } as Workspace;
}

function thread(id: string, missionId: string, ts: string, patch: Partial<MissionThread> = {}): MissionThread {
  return { id, missionId, teamId: "T1", channelId: "C1", threadTs: ts, permalink: `https://acme.slack.com/archives/C1/p${ts.replace(".", "")}`, startedBy: "ana", startedBySlack: "UANA", lastRequestTs: ts, muted: false, ...patch };
}

/** m1 on call in C1, m2 in C2; m3 in none. m1's threads: one live, one
 *  muted, and one left from a channel it was on call in before. */
function world() {
  const sessions = [session("m1", { kind: "mission" }), session("m2", { kind: "mission" }), session("m3", { kind: "mission" })];
  const bindings: MissionChannel[] = [
    { missionId: "m1", orgId: "o1", teamId: "T1", channelId: "C1", boundBy: "wes", listen: "mentions", allowBotMessages: false, paused: false },
    { missionId: "m2", orgId: "o1", teamId: "T1", channelId: "C2", boundBy: "wes", listen: "mentions", allowBotMessages: false, paused: false },
  ];
  const threads = [
    thread("t1", "m1", "1731400000.000100"),
    thread("t2", "m2", "1731400000.000200", { channelId: "C2" }),
    thread("t3", "m1", "1731400000.000300", { muted: true }),
    thread("t4", "m1", "1731400000.000400", { channelId: "C9" }),
  ];
  const posts: string[] = [];
  const reactions: string[] = [];
  const ledger: { id: string; missionId: string; threadId: string | null; runnerId: string | null }[] = [];
  const audits: string[] = [];
  const started: RunnerStart[] = [];
  const state = { perHour: 6, failStart: false };
  const slack: MissionSlackDeps = {
    binding: async (missionId) => bindings.find((b) => b.missionId === missionId) ?? null,
    thread: async (missionId, ts) => threads.find((t) => t.missionId === missionId && t.threadTs === ts) ?? null,
    post: async (binding, ts, message) => {
      posts.push(`${binding.channelId}/${ts}: ${"markdown" in message ? message.markdown : `[card] ${message.text}`}`);
      return "1731400099.000100";
    },
    react: async (binding, ts, name) => {
      reactions.push(`${binding.channelId}/${ts}: ${name}`);
    },
    saveAsk: async () => "00000000-0000-0000-0000-0000000000aa",
    setAskMessage: async () => undefined,
    askBlocks,
    reserveShip: async (missionId, t) => {
      if (ledger.filter((l) => l.missionId === missionId).length >= state.perHour) return { refused: "hour", limit: state.perHour };
      const id = `s${ledger.length + 1}`;
      ledger.push({ id, missionId, threadId: t?.id ?? null, runnerId: null });
      return { id };
    },
    linkShip: async (id, runnerId) => {
      ledger.find((l) => l.id === id)!.runnerId = runnerId;
    },
    releaseShip: async (id) => {
      const at = ledger.findIndex((l) => l.id === id && !l.runnerId);
      if (at >= 0) ledger.splice(at, 1);
    },
    auditShip: async (mission, _binding, t, runnerId) => {
      audits.push(`${mission.id}:${t?.threadTs ?? "-"}:${runnerId}`);
    },
    requester: async () => ({ name: "Ana", permalink: "https://acme.slack.com/archives/C1/p1731400000000100" }),
  };
  let n = 0;
  const deps: MissionToolDeps = {
    access: async () => null,
    environmentReady: async () => null,
    session: async (id) => sessions.find((s) => s.id === id) ?? null,
    runners: async () => [],
    working: async () => false,
    latestResponse: async () => null,
    pullRequests: async () => [],
    startRunner: async (_m, start) => {
      if (state.failStart) return { error: "the plan's box limit" };
      started.push(start);
      return { runnerId: `r${++n}` };
    },
    send: async () => true,
    queue: async () => undefined,
    queued: async () => new Map(),
    archive: async () => true,
    readNotes: async () => ({ body: "", updatedAt: null }),
    writeNotes: async () => undefined,
    slack,
  };
  return { deps, posts, reactions, ledger, audits, started, state, bindings };
}

const call = (deps: MissionToolDeps, missionId: string, name: string, args: Record<string, unknown>) => callMissionTool({ missionId }, name, args, deps);

test("the Slack tools are listed with the Mission's others", () => {
  const names = MISSION_TOOLS.map((t) => t.name);
  for (const name of ["slack_reply", "slack_ask", "slack_react"]) assert.ok(names.includes(name), name);
  const spawn = MISSION_TOOLS.find((t) => t.name === "spawn_runner")!;
  assert.ok((spawn.inputSchema.properties as Record<string, unknown>).thread);
});

test("a Mission posts only in its own threads of the channel it's on call in", async () => {
  const { deps, posts, reactions } = world();
  const own = await call(deps, "m1", "slack_reply", { thread: "1731400000.000100", text: "On it." });
  assert.equal(own.isError, undefined);
  assert.deepEqual(posts, ["C1/1731400000.000100: On it."]);
  // Another Mission's thread, a thread of a channel it's no longer on call
  // in, an unknown one, and a malformed one: no such thread, alike.
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
  // A muted thread: refused, said why.
  const muted = await call(deps, "m1", "slack_reply", { thread: "1731400000.000300", text: "x" });
  assert.match(muted.text, /muted/);
  // m2 reaches its own, not m1's.
  assert.equal((await call(deps, "m2", "slack_reply", { thread: "1731400000.000200", text: "Hi" })).isError, undefined);
  assert.equal((await call(deps, "m2", "slack_reply", { thread: "1731400000.000100", text: "Hi" })).isError, true);
  // Off call: its Slack tools are off.
  const off = await call(deps, "m3", "slack_reply", { thread: "1731400000.000100", text: "x" });
  assert.match(off.text, /isn't on call/);
  assert.deepEqual(posts, ["C1/1731400000.000100: On it.", "C2/1731400000.000200: Hi"]);
  assert.deepEqual(reactions, []);
});

test("slack_react marks the thread's latest request with one of three emoji", async () => {
  const { deps, reactions } = world();
  assert.equal((await call(deps, "m1", "slack_react", { thread: "1731400000.000100", emoji: "eyes" })).isError, undefined);
  assert.equal((await call(deps, "m1", "slack_react", { thread: "1731400000.000100", emoji: "✅" })).isError, undefined);
  assert.equal((await call(deps, "m1", "slack_react", { thread: "1731400000.000100", emoji: "tada" })).isError, true);
  assert.deepEqual(reactions, ["C1/1731400000.000100: eyes", "C1/1731400000.000100: white_check_mark"]);
});

test("slack_ask posts a card with its options and Other", async () => {
  const { deps, posts } = world();
  const asked = await call(deps, "m1", "slack_ask", { thread: "1731400000.000100", question: "Which env?", options: ["staging", "prod", "staging"] });
  assert.equal(asked.isError, undefined);
  assert.deepEqual(posts, ["C1/1731400000.000100: [card] Which env?"]);
  const blocks = askBlocks("00000000-0000-0000-0000-0000000000aa", "Which env?", ["staging", "prod"]);
  const buttons = (blocks[1] as { elements: { value: string }[] }).elements.map((e) => e.value);
  assert.deepEqual(buttons.map(parseAskValue), [
    { askId: "00000000-0000-0000-0000-0000000000aa", option: 0 },
    { askId: "00000000-0000-0000-0000-0000000000aa", option: 1 },
    { askId: "00000000-0000-0000-0000-0000000000aa", option: "other" },
  ]);
  assert.equal((await call(deps, "m1", "slack_ask", { thread: "1731400000.000100", question: "q", options: [] })).isError, true);
  assert.equal((await call(deps, "m1", "slack_ask", { thread: "1731400000.000100", question: "q", options: ["1", "2", "3", "4", "5", "6"] })).isError, true);
});

test("spawn_runner for a thread: linked, the requester in its brief, audited", async () => {
  const { deps, ledger, audits, started } = world();
  const result = await call(deps, "m1", "spawn_runner", { prompt: "Fix the login bug.", thread: "1731400000.000100" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(ledger, [{ id: "s1", missionId: "m1", threadId: "t1", runnerId: "r1" }]);
  assert.deepEqual(audits, ["m1:1731400000.000100:r1"]);
  assert.match(started[0].brief, /^Fix the login bug\.\n\n---\nRequested in Slack by Ana \(https:\/\/acme\.slack\.com/);
  assert.match(started[0].brief, /Requested by Ana in Slack\./);
  // Another Mission's thread: refused, nothing started or reserved.
  const other = await call(deps, "m1", "spawn_runner", { prompt: "x", thread: "1731400000.000200" });
  assert.equal(other.isError, true);
  assert.equal(started.length, 1);
  assert.equal(ledger.length, 1);
});

test("on call, every Ship counts against the limits; one reached is told in the thread and starts nothing", async () => {
  const { deps, ledger, started, posts, state } = world();
  state.perHour = 2;
  assert.equal((await call(deps, "m1", "spawn_runner", { prompt: "a", thread: "1731400000.000100" })).isError, undefined);
  // No thread: counted all the same.
  assert.equal((await call(deps, "m1", "spawn_runner", { prompt: "b" })).isError, undefined);
  const third = await call(deps, "m1", "spawn_runner", { prompt: "c", thread: "1731400000.000100" });
  assert.equal(third.isError, true);
  assert.match(third.text, /limit on Ships started while on call \(2 in an hour\)/);
  assert.equal(started.length, 2);
  assert.equal(ledger.length, 2);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /^C1\/1731400000\.000100: I've started 2 Ships for this channel in the last hour, which is my limit/);
  // m2's limit is its own.
  assert.equal((await call(deps, "m2", "spawn_runner", { prompt: "d" })).isError, undefined);
});

test("a start that fails gives its place back; a Mission off call isn't limited", async () => {
  const { deps, ledger, state, started } = world();
  state.failStart = true;
  const failed = await call(deps, "m1", "spawn_runner", { prompt: "a", thread: "1731400000.000100" });
  assert.equal(failed.isError, true);
  assert.equal(ledger.length, 0);
  state.failStart = false;
  state.perHour = 0;
  assert.equal((await call(deps, "m3", "spawn_runner", { prompt: "free" })).isError, undefined);
  assert.equal(started.length, 1);
  // ...but naming a thread off call is refused.
  assert.match((await call(deps, "m3", "spawn_runner", { prompt: "x", thread: "1731400000.000100" })).text, /isn't on call/);
});

test("a Ship's pull request ready, merged or closed is posted in its thread, once each kind, never muted", async () => {
  const posted: string[] = [];
  const threads: Record<string, MissionThread> = {
    r1: thread("t1", "m1", "1731400000.000100"),
    r2: thread("t3", "m1", "1731400000.000300", { muted: true }),
    r3: thread("t4", "m1", "1731400000.000400", { channelId: "C9" }),
  };
  const deps: AnnounceDeps = {
    shipThread: async (runnerId) => threads[runnerId] ?? null,
    binding: async () => ({ missionId: "m1", orgId: "o1", teamId: "T1", channelId: "C1", boundBy: null, listen: "mentions", allowBotMessages: false, paused: false }),
    latestThread: async () => threads.r1,
    post: async (binding, ts, text) => {
      posted.push(`${binding.channelId}/${ts}: ${text}`);
    },
  };
  const pr = { repo: "acme/web", number: 7, url: "https://github.com/acme/web/pull/7", title: "Fix <login>" };
  assert.equal(await announceShipEvent({ runnerId: "r1", kind: "ready", payload: { runner: "login-fix", pr } }, deps), true);
  assert.equal(await announceShipEvent({ runnerId: "r1", kind: "merged", payload: { runner: "login-fix", pr } }, deps), true);
  assert.equal(await announceShipEvent({ runnerId: "r1", kind: "finished", payload: { runner: "login-fix", pr } }, deps), false);
  assert.equal(await announceShipEvent({ runnerId: "r2", kind: "ready", payload: { pr } }, deps), false, "muted");
  assert.equal(await announceShipEvent({ runnerId: "r3", kind: "ready", payload: { pr } }, deps), false, "another channel");
  assert.equal(await announceShipEvent({ runnerId: "r9", kind: "ready", payload: { pr } }, deps), false, "no thread");
  assert.deepEqual(posted, [
    "C1/1731400000.000100: :white_check_mark: Ready for review: <https://github.com/acme/web/pull/7|#7 Fix login> (Ship login-fix)",
    "C1/1731400000.000100: :rocket: Merged: <https://github.com/acme/web/pull/7|#7 Fix login> (Ship login-fix)",
  ]);
  assert.equal(await announceWaiting("m1", "https://outrunner.example.com/workspaces/m1", deps), true);
  assert.match(posted[2], /waiting on a decision from its owner before it goes on: <https:\/\/outrunner\.example\.com\/workspaces\/m1\|answer in Outrunner>/);
});
