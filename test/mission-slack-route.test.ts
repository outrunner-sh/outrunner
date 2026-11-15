/**
 * Slack → a Mission on call (lib/missions/slack-route.ts): which messages a
 * bound channel's Mission takes, and which go on to the Slack agent; Slack's
 * retries recorded once; the gate (linked, same org, read on the project);
 * the thread keywords, pause, bots, and the exact commands.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { MissionChannel, MissionRequest, MissionThread } from "@/lib/missions/slack-store";
import { routeToMission, type SlackRouteDeps, type SlackRouteMessage } from "@/lib/missions/slack-route";
import {
  ASSIGN_ELSEWHERE,
  ASSIGN_USAGE,
  assignedNote,
  assigneeNotLinkedText,
  NEW_USAGE,
  ON_CALL_HELP,
  onCallCommand,
  threadKeyword,
} from "@/lib/missions/slack-text";
import type { RecordedEvent } from "@/lib/missions/watch";
import type { AccessLevel } from "@/lib/orgs/access";
import type { Workspace } from "@/lib/runtime/types";

const BOT = "UBOT";

function mission(id: string, patch: Partial<Workspace> = {}): Workspace {
  return { id, kind: "mission", status: "ready", ownerId: "owner", projectId: "p1", environmentId: "env1", title: `Mission ${id}`, branch: "b", ...patch } as Workspace;
}

/** Channel C1 bound to m1 in org o1; C2 bound to nobody. Alice is linked
 *  with read, Wes with write, Bob in another org, Nora with no access, and
 *  Una isn't linked. */
function world(patch: { binding?: Partial<MissionChannel>; mission?: Partial<Workspace> } = {}) {
  const bindings: MissionChannel[] = [
    { missionId: "m1", orgId: "o1", teamId: "T1", channelId: "C1", boundBy: "wes", listen: "mentions", allowBotMessages: false, paused: false, revision: "rev1", ...patch.binding },
  ];
  const threads: MissionThread[] = [];
  const missions = new Map<string, Workspace>([["m1", { ...mission("m1"), ...patch.mission } as Workspace], ["m2", mission("m2")]]);
  const events: RecordedEvent[] = [];
  const requests: MissionRequest[] = [];
  const said: string[] = [];
  const linkedUsers: Record<string, { userId: string; orgId: string }> = {
    UALICE: { userId: "alice", orgId: "o1" },
    UWES: { userId: "wes", orgId: "o1" },
    UBOB: { userId: "bob", orgId: "o2" },
    UNORA: { userId: "nora", orgId: "o1" },
  };
  const levels: Record<string, AccessLevel | null> = { alice: "read", wes: "write", nora: null, bob: "read" };
  const state = { stopped: [] as string[], open: new Map<string, number>(),
    ships: new Map<string, number>(), stopFails: false, bound: [] as string[], created: 0,
    newThreads: [] as Parameters<SlackRouteDeps["newThreadRequest"]>[0][],
    assigned: [] as Parameters<SlackRouteDeps["assignThread"]>[0][] };
  const deps: SlackRouteDeps = {
    botUserId: BOT,
    binding: async (team, channel) => bindings.find((b) => b.teamId === team && b.channelId === channel) ?? null,
    thread: async (team, channel, ts) => threads.find((t) => t.teamId === team && t.channelId === channel && t.threadTs === ts) ?? null,
    mission: async (id) => missions.get(id) ?? null,
    linked: async (slackUserId) => linkedUsers[slackUserId] ?? null,
    level: async (userId) => levels[userId] ?? null,
    projectName: async () => "web",
    newThreadRequest: async (input) => {
      if (!state.newThreads.some((n) => n.key === input.key)) state.newThreads.push(input);
      return "queued";
    },
    // The thread's open requests (state.open) take the assignee.
    assignThread: async (input) => {
      state.assigned.push(input);
      return state.open.get(input.threadId) ?? 0;
    },
    acceptThread: async (input) => {
      let thread = threads.find((t) => t.threadTs === input.threadTs);
      if (thread) {
        thread.missionId = input.missionId;
        thread.lastRequestTs = input.requestTs;
      } else {
        thread = {
          id: `t${threads.length + 1}`,
          missionId: input.missionId,
          teamId: "T1",
          channelId: "C1",
          threadTs: input.threadTs,
          permalink: input.permalink,
          startedBy: input.startedBy,
          startedBySlack: input.startedBySlack,
          lastRequestTs: input.requestTs,
          muted: false,
        };
        threads.push(thread);
      }
      return thread;
    },
    recordRequest: async (request) => {
      if (!requests.some((r) => r.missionId === request.missionId && r.requestKey === request.requestKey)) requests.push(request);
    },
    setMuted: async (id, muted) => {
      threads.find((t) => t.id === id)!.muted = muted;
    },
    setPaused: async (missionId, paused) => {
      bindings.find((b) => b.missionId === missionId)!.paused = paused;
    },
    unbind: async (binding) => {
      bindings.splice(bindings.indexOf(binding), 1);
    },
    // As mission_events' unique key does: a key seen before records nothing.
    enqueue: async (event) => {
      if (events.some((e) => e.key === event.key)) return false;
      events.push(event);
      return true;
    },
    stopThread: async (mission, threadId) => {
      if (state.stopFails) throw new Error("down");
      state.stopped.push(`${mission.id}:${threadId}`);
      return { requests: state.open.get(threadId) ?? 0, ships: state.ships.get(threadId) ?? 0 };
    },
    name: async (id) => `name-of-${id}`,
    permalink: async (ts) => `https://acme.slack.com/archives/C1/p${ts.replace(".", "")}`,
    reply: async (_ts, text) => {
      said.push(`reply: ${text}`);
    },
    tell: async (_ts, text) => {
      said.push(`tell: ${text}`);
    },
    askToConnect: async () => {
      said.push("connect");
    },
    findProject: async (_r, name) => (name.toLowerCase() === "web" ? { id: "env1", name: "web" } : name === "dup" ? { ambiguous: ["dup", "Dup"] } : null),
    projectLevel: async (userId) => levels[userId] ?? null,
    localChannel: async () => true,
    freeMissions: async () => [],
    createMission: async () => {
      state.created++;
      missions.set("m9", mission("m9"));
      return { missionId: "m9" };
    },
    bind: async (input) => {
      state.bound.push(input.missionId);
      bindings.push({ missionId: input.missionId, orgId: input.orgId, teamId: "T1", channelId: "C2", boundBy: input.boundBy, listen: "mentions", allowBotMessages: false, paused: false, revision: "rev1" });
      return "bound";
    },
    announce: async () => {
      said.push("announced");
    },
  };
  return { deps, events, said, threads, bindings, state, requests };
}

function msg(patch: Partial<SlackRouteMessage> = {}): SlackRouteMessage {
  return { teamId: "T1", channel: "C1", user: "UALICE", text: `<@${BOT}> fix the login bug`, ts: "1731400000.000100", mention: true, eventId: "Ev1", ...patch };
}

test("a mention in a bound channel goes to its Mission as a slack_request, not the spec-card flow", async () => {
  const w = world();
  assert.equal(await routeToMission(msg({ files: ["trace.txt"] }), w.deps), true);
  assert.equal(w.events.length, 1);
  const [event] = w.events;
  assert.equal(event.kind, "slack_request");
  assert.equal(event.missionId, "m1");
  assert.equal(event.runnerId, null);
  assert.equal(event.key, "slack_request:Ev1");
  assert.deepEqual(event.payload.slack, {
    channel: "C1",
    thread: "1731400000.000100",
    request: "Ev1",
    ts: "1731400000.000100",
    permalink: "https://acme.slack.com/archives/C1/p1731400000000100",
    author: "name-of-UALICE",
    slackUserId: "UALICE",
    userId: "alice",
    text: "fix the login bug",
    files: ["trace.txt"],
  });
  // The thread is the Mission's now: a reply there needs no mention.
  assert.equal(w.threads[0].missionId, "m1");
  // The request is recorded before the Mission hears of it: who asked, under
  // which binding.
  assert.deepEqual(w.requests, [
    { missionId: "m1", requestKey: "Ev1", threadId: "t1", bindingRevision: "rev1", messageTs: "1731400000.000100", requestedBy: "alice", requestedBySlack: "UALICE" },
  ]);
  assert.equal(await routeToMission(msg({ mention: false, text: "also the signup page", ts: "1731400001.000100", threadTs: "1731400000.000100", eventId: "Ev2" }), w.deps), true);
  assert.equal(w.events.length, 2);
  assert.equal(w.events[1].payload.slack?.thread, "1731400000.000100");
  // Two requests in one thread, each its own.
  assert.deepEqual(w.requests.map((r) => [r.requestKey, r.threadId]), [["Ev1", "t1"], ["Ev2", "t1"]]);
});

test("an unbound channel, DMs, and others' threads go on to the Slack agent", async () => {
  const w = world();
  assert.equal(await routeToMission(msg({ channel: "C2" }), w.deps), false);
  assert.equal(await routeToMission(msg({ channel: "D1", channelType: "im" }), w.deps), false);
  // A reply with no mention in a thread the Mission didn't take: not its.
  assert.equal(await routeToMission(msg({ mention: false, threadTs: "1731300000.000100", text: "hello" }), w.deps), false);
  // A new message in the channel with no mention: listen is mentions.
  assert.equal(await routeToMission(msg({ mention: false, text: "hello" }), w.deps), false);
  // `stop` in a channel with no Mission is the agent's own (a session's turn).
  assert.equal(await routeToMission(msg({ channel: "C2", text: `<@${BOT}> stop` }), w.deps), false);
  // The bot's own message: never.
  assert.equal(await routeToMission(msg({ user: BOT }), w.deps), false);
  assert.equal(w.events.length, 0);
});

test("Slack's retries of an event are one request", async () => {
  const w = world();
  await routeToMission(msg(), w.deps);
  await routeToMission(msg(), w.deps);
  assert.equal(w.events.length, 1);
  assert.equal(w.requests.length, 1);
  // With no event id, the message's own place is its key: still once.
  const v = world();
  await routeToMission(msg({ eventId: null }), v.deps);
  await routeToMission(msg({ eventId: null }), v.deps);
  assert.equal(v.events.length, 1);
  assert.equal(v.events[0].key, "slack_request:T1:C1:1731400000.000100");
});

test("the gate: linked, in the Mission's org, with read on its project", async () => {
  const w = world();
  assert.equal(await routeToMission(msg({ user: "UUNA" }), w.deps), true);
  assert.equal(await routeToMission(msg({ user: "UBOB" }), w.deps), true);
  assert.equal(await routeToMission(msg({ user: "UNORA" }), w.deps), true);
  assert.equal(w.events.length, 0);
  assert.deepEqual(w.said, [
    "connect",
    "tell: Your Slack account is connected to a different Outrunner org than the Mission on call here.",
    "tell: Only people who can read web in Outrunner can give the Mission on call here work.",
  ]);
  // And no thread was taken for them.
  assert.equal(w.threads.length, 0);
});

test("in its own threads, plain replies that don't pass the gate are dropped quietly", async () => {
  const w = world();
  await routeToMission(msg(), w.deps);
  const reply = (user: string, n: number, mention = false) =>
    routeToMission(msg({ user, mention, text: mention ? `<@${BOT}> hi` : "hi", threadTs: "1731400000.000100", ts: `173140002${n}.000100`, eventId: `Eq${n}` }), w.deps);
  assert.equal(await reply("UUNA", 1), true);
  assert.equal(await reply("UBOB", 2), true);
  assert.equal(await reply("UNORA", 3), true);
  assert.deepEqual(w.said, [], "nobody nagged on a plain reply");
  assert.equal(w.events.length, 1);
  // A mention still tells them why.
  await reply("UUNA", 4, true);
  assert.deepEqual(w.said, ["connect"]);
  // !aside and a muted thread need nobody's identity.
  w.threads[0].muted = true;
  assert.equal(await reply("UUNA", 5), true);
  assert.deepEqual(w.said, ["connect"]);
});

test("keywords: !aside is ignored, !mute and !unmute a thread", async () => {
  const w = world();
  await routeToMission(msg(), w.deps);
  const inThread = (text: string, mention = false, n = 0) =>
    routeToMission(msg({ text, mention, threadTs: "1731400000.000100", ts: `173140001${n}.000100`, eventId: `E-${text}-${n}` }), w.deps);
  assert.equal(await inThread("!aside lunch?"), true);
  assert.equal(await inThread("!mute"), true);
  assert.equal(w.threads[0].muted, true);
  assert.equal(await inThread("more detail", false, 1), true);
  assert.equal(await inThread(`<@${BOT}> are you there`, true, 2), true);
  assert.equal(w.events.length, 1, "nothing reaches it from a muted thread");
  assert.equal(await inThread("!unmute"), true);
  assert.equal(await inThread("more detail", false, 3), true);
  assert.equal(w.events.length, 2);
  assert.ok(w.said.some((s) => s.startsWith("reply: Muted")));
  assert.ok(w.said.includes("tell: This thread is muted. Say `!unmute` first."));
});

test("paused, it says so and takes nothing; pause and resume need write", async () => {
  const w = world();
  assert.equal(await routeToMission(msg({ text: `<@${BOT}> pause` }), w.deps), true);
  assert.equal(w.bindings[0].paused, false, "read isn't enough");
  assert.equal(await routeToMission(msg({ user: "UWES", text: `<@${BOT}> pause`, eventId: "Ep" }), w.deps), true);
  assert.equal(w.bindings[0].paused, true);
  assert.equal(await routeToMission(msg({ eventId: "Ex" }), w.deps), true);
  assert.equal(w.events.length, 0);
  assert.ok(w.said.some((s) => s.startsWith("reply: The Mission on call here is paused")));
  await routeToMission(msg({ user: "UWES", text: `<@${BOT}> resume`, eventId: "Er" }), w.deps);
  assert.equal(w.bindings[0].paused, false);
  await routeToMission(msg({ eventId: "Ey" }), w.deps);
  assert.equal(w.events.length, 1);
});

test("@Outrunner stop stops that thread's work only; stop being on call here unbinds", async () => {
  const w = world();
  // Two threads, each with a request: the Mission takes both.
  await routeToMission(msg({ ts: "1731400000.000100", eventId: "Ea" }), w.deps);
  await routeToMission(msg({ ts: "1731400100.000100", eventId: "Eb" }), w.deps);
  const [a, b] = w.threads;
  w.state.open.set(a.id, 2);
  w.state.open.set(b.id, 1);
  w.state.ships.set(a.id, 1);
  await routeToMission(msg({ ts: "1731400200.000100", threadTs: a.threadTs, text: `<@${BOT}> stop`, eventId: "Es" }), w.deps);
  assert.deepEqual(w.state.stopped, [`m1:${a.id}`], "only the thread it was said in");
  assert.match(w.said.at(-1) ?? "", /Stopped: 2 requests cancelled and 1 Ship's turn interrupted.*Other threads go on/);
  // A thread the Mission never took has nothing open, and nothing is asked of the store.
  await routeToMission(msg({ ts: "1731400300.000100", threadTs: "1731300000.000100", text: `<@${BOT}> stop`, eventId: "Es2" }), w.deps);
  assert.deepEqual(w.state.stopped, [`m1:${a.id}`]);
  assert.equal(w.said.at(-1), "reply: Nothing is open in this thread.");
  // The store failing is said, not swallowed.
  w.state.stopFails = true;
  await routeToMission(msg({ ts: "1731400400.000100", threadTs: b.threadTs, text: `<@${BOT}> stop`, eventId: "Es3" }), w.deps);
  assert.match(w.said.at(-1) ?? "", /couldn't reach the Mission to stop this thread's work/);
  await routeToMission(msg({ text: `<@${BOT}> stop being on call here`, eventId: "E2" }), w.deps);
  assert.equal(w.bindings.length, 1, "needs write");
  await routeToMission(msg({ user: "UWES", text: `<@${BOT}> stop being on call here`, eventId: "E3" }), w.deps);
  assert.equal(w.bindings.length, 0);
});

test("bots: never, unless the channel takes bots' messages and they mention it; then vouched for by its binder", async () => {
  const w = world();
  assert.equal(await routeToMission(msg({ user: "UCIBOT", botId: "B1" }), w.deps), true);
  assert.equal(w.events.length, 0);
  const v = world({ binding: { allowBotMessages: true } });
  assert.equal(await routeToMission(msg({ user: "UCIBOT", botId: "B1" }), v.deps), true);
  assert.equal(v.events.length, 1);
  assert.equal(v.events[0].payload.slack?.userId, "wes");
  assert.equal(v.events[0].payload.slack?.author, "a bot (B1)");
  // Never a bot's reply in a thread, mention or not: its own posts can't loop.
  assert.equal(await routeToMission(msg({ user: "UCIBOT", botId: "B1", mention: false, threadTs: "1731400000.000100", ts: "1731400002.000100", eventId: "Eb2" }), v.deps), true);
  assert.equal(v.events.length, 1);
  // A bot's text is never a command.
  const u = world({ binding: { allowBotMessages: true } });
  await routeToMission(msg({ user: "UCIBOT", botId: "B1", text: `<@${BOT}> stop being on call here` }), u.deps);
  assert.equal(u.bindings.length, 1);
});

test("an archived Mission says so and takes nothing", async () => {
  const w = world({ mission: { status: "archived" } });
  assert.equal(await routeToMission(msg(), w.deps), true);
  assert.equal(w.events.length, 0);
  assert.ok(w.said[0].startsWith("reply: ") && w.said[0].includes("archived"));
  // A plain reply in its thread is told only to its sender.
  w.threads.push({ id: "tx", missionId: "m1", teamId: "T1", channelId: "C1", threadTs: "1731400000.000100", permalink: null, startedBy: "alice", startedBySlack: "UALICE", lastRequestTs: null, muted: false });
  await routeToMission(msg({ mention: false, text: "any news?", threadTs: "1731400000.000100", ts: "1731400003.000100", eventId: "Ea2" }), w.deps);
  assert.ok(w.said[1].startsWith("tell: ") && w.said[1].includes("archived"));
});

test("be on call here: needs write on the project; binds a Mission, or starts one", async () => {
  const w = world();
  // Alice can only read web.
  await routeToMission(msg({ channel: "C2", text: `<@${BOT}> be on call here for web` }), w.deps);
  assert.deepEqual(w.state.bound, []);
  assert.ok(w.said.at(-1)?.includes("needs write on web"));
  await routeToMission(msg({ channel: "C2", user: "UWES", text: `<@${BOT}> be on call here for "Web".` }), w.deps);
  assert.deepEqual(w.state.bound, ["m9"]);
  assert.equal(w.state.created, 1);
  assert.equal(w.said.at(-1), "announced");
  // A channel with a Mission already says which.
  await routeToMission(msg({ channel: "C1", user: "UWES", text: `<@${BOT}> be on call here for web` }), w.deps);
  assert.ok(w.said.at(-1)?.includes('Mission "Mission m1" is on call here already'));
  // Unknown and ambiguous names.
  await routeToMission(msg({ channel: "C3", user: "UWES", text: `<@${BOT}> be on call here for nope` }), w.deps);
  assert.ok(w.said.at(-1)?.includes("couldn't find a project"));
  await routeToMission(msg({ channel: "C3", user: "UWES", text: `<@${BOT}> be on call here for dup` }), w.deps);
  assert.ok(w.said.at(-1)?.includes("Several projects match"));
  // Unlinked people connect first.
  await routeToMission(msg({ channel: "C3", user: "UUNA", text: `<@${BOT}> be on call here for web` }), w.deps);
  assert.equal(w.said.at(-1), "connect");
});

test("commands are exact, parsed before any model", () => {
  assert.deepEqual(onCallCommand(`<@${BOT}> be on call here for acme/web`, BOT), { action: "bind", project: "acme/web" });
  assert.deepEqual(onCallCommand(`<@${BOT}> be on call here`, BOT), { action: "help" });
  assert.deepEqual(onCallCommand(`<@${BOT}> pause.`, BOT), { action: "pause" });
  assert.deepEqual(onCallCommand(`<@${BOT}|outrunner> STOP`, BOT), { action: "stop" });
  assert.equal(onCallCommand(`<@${BOT}> please stop the deploy`, BOT), null);
  assert.equal(onCallCommand(`<@${BOT}> pause the billing job`, BOT), null);
  assert.equal(threadKeyword("!aside nothing"), "aside");
  assert.equal(threadKeyword("(aside) nothing"), "aside");
  assert.equal(threadKeyword("not !mute"), null);
});

// --- !help, !new <task>, !assign @person -----------------------------------

test("!help: the on-call help, told to the sender alone, whoever asks", async () => {
  const w = world();
  assert.equal(await routeToMission(msg({ text: `<@${BOT}> !help` }), w.deps), true);
  assert.equal(await routeToMission(msg({ user: "UUNA", text: `<@${BOT}> !help`, eventId: "Eh2" }), w.deps), true);
  assert.deepEqual(w.said, [`tell: ${ON_CALL_HELP}`, `tell: ${ON_CALL_HELP}`]);
  for (const keyword of ["!help", "!new <task>", "!assign @person"]) assert.ok(ON_CALL_HELP.includes(keyword), keyword);
  assert.equal(w.events.length, 0);
  assert.equal(w.threads.length, 0);
});

test("!new <task>: a fresh request in a new thread, with nothing of the thread it was typed in", async () => {
  const w = world();
  await routeToMission(msg(), w.deps);
  const [old] = w.threads;
  // A plain reply in the Mission's thread.
  const typed = msg({ mention: false, text: "!new  deploy the docs ", threadTs: old.threadTs, ts: "1731400010.000100", eventId: "En" });
  assert.equal(await routeToMission(typed, w.deps), true);
  assert.equal(await routeToMission(typed, w.deps), true, "Slack's retry");
  assert.deepEqual(w.state.newThreads, [
    { missionId: "m1", key: "new:En", task: "deploy the docs", requestedBy: "alice", requestedBySlack: "UALICE", author: "name-of-UALICE" },
  ]);
  // Nothing recorded or told against the thread it was typed in.
  assert.equal(w.requests.length, 1);
  assert.equal(w.events.length, 1);
  assert.equal(w.threads.length, 1);
  assert.equal(old.lastRequestTs, "1731400000.000100");
  assert.deepEqual(w.said, []);
  // At the top of the channel, with a mention.
  await routeToMission(msg({ text: `<@${BOT}> !new fix CI`, ts: "1731400020.000100", eventId: "En2" }), w.deps);
  assert.equal(w.state.newThreads.at(-1)?.task, "fix CI");
  assert.equal(w.state.newThreads.at(-1)?.key, "new:En2");
});

test("!new is gated as a request is: linked, same org, read, not paused", async () => {
  const w = world();
  const ask = (user: string, n: number) => routeToMission(msg({ user, text: `<@${BOT}> !new fix it`, eventId: `Eg${n}` }), w.deps);
  await ask("UUNA", 1);
  await ask("UBOB", 2);
  await ask("UNORA", 3);
  assert.deepEqual(w.said, [
    "connect",
    "tell: Your Slack account is connected to a different Outrunner org than the Mission on call here.",
    "tell: Only people who can read web in Outrunner can give the Mission on call here work.",
  ]);
  w.bindings[0].paused = true;
  await ask("UALICE", 4);
  assert.match(w.said.at(-1) ?? "", /^reply: The Mission on call here is paused/);
  assert.deepEqual(w.state.newThreads, []);
});

test("!new with no task: a short usage hint, to the sender", async () => {
  const w = world();
  await routeToMission(msg({ text: `<@${BOT}> !new` }), w.deps);
  assert.deepEqual(w.said, [`tell: ${NEW_USAGE}`]);
  assert.deepEqual(w.state.newThreads, []);
  assert.equal(w.events.length, 0);
});

test("a bot's !new is its text, not a command", async () => {
  const w = world({ binding: { allowBotMessages: true } });
  await routeToMission(msg({ user: "UCIBOT", botId: "B1", text: `<@${BOT}> !new fix it` }), w.deps);
  assert.deepEqual(w.state.newThreads, []);
  assert.equal(w.events[0].payload.slack?.text, "!new fix it");
});

test("!assign outside a thread the Mission is in: refused as !mute is", async () => {
  const w = world();
  await routeToMission(msg({ text: `<@${BOT}> !assign <@UWES>` }), w.deps);
  await routeToMission(msg({ text: `<@${BOT}> !assign <@UWES>`, threadTs: "1731300000.000100", ts: "1731400030.000100", eventId: "Ea2" }), w.deps);
  assert.deepEqual(w.said, [`tell: ${ASSIGN_ELSEWHERE}`, `tell: ${ASSIGN_ELSEWHERE}`]);
  assert.equal(ASSIGN_ELSEWHERE, "`!assign` works in a thread the Mission is in.");
  assert.deepEqual(w.state.assigned, []);
});

test("!assign needs exactly one person and no other keyword", async () => {
  const w = world();
  await routeToMission(msg(), w.deps);
  const [t] = w.threads;
  w.state.open.set(t.id, 1);
  const texts = ["!assign", `<@${BOT}> !assign <@${BOT}>`, "!assign <@UWES> <@UNORA>", "!assign <@UWES> !mute", "!assign <@UWES> (aside)"];
  for (const [n, text] of texts.entries()) {
    await routeToMission(msg({ text, mention: text.includes(BOT), threadTs: t.threadTs, ts: `173140004${n}.000100`, eventId: `Eu${n}` }), w.deps);
  }
  assert.deepEqual(w.said, texts.map(() => `tell: ${ASSIGN_USAGE}`));
  assert.deepEqual(w.state.assigned, []);
  assert.equal(t.muted, false, "the !mute in it did nothing");
  assert.equal(w.events.length, 1);
});

test("!assign to someone not linked in the Mission's org: told to the sender, nothing assigned", async () => {
  const w = world();
  await routeToMission(msg(), w.deps);
  const [t] = w.threads;
  w.state.open.set(t.id, 1);
  await routeToMission(msg({ mention: false, text: "!assign <@UUNA>", threadTs: t.threadTs, ts: "1731400050.000100", eventId: "Ec1" }), w.deps);
  await routeToMission(msg({ mention: false, text: "!assign <@UBOB>", threadTs: t.threadTs, ts: "1731400051.000100", eventId: "Ec2" }), w.deps);
  assert.deepEqual(w.said, [`tell: ${assigneeNotLinkedText("UUNA", false)}`, `tell: ${assigneeNotLinkedText("UBOB", true)}`]);
  assert.match(w.said[0], /<@UUNA> hasn't connected Slack to Outrunner, so nothing was assigned/);
  assert.deepEqual(w.state.assigned, []);
  assert.equal(w.events.length, 1);
});

test("!assign @person: the thread's open requests are theirs; the Mission isn't stopped, and is told", async () => {
  const w = world();
  // Alice can only read web: enough to assign.
  await routeToMission(msg(), w.deps);
  const [t] = w.threads;
  w.state.open.set(t.id, 2);
  w.state.ships.set(t.id, 1);
  await routeToMission(msg({ mention: false, text: "!assign <@UWES>", threadTs: t.threadTs, ts: "1731400060.000100", eventId: "Ea" }), w.deps);
  assert.deepEqual(w.state.assigned, [{ missionId: "m1", threadId: t.id, assignee: "wes", by: "alice" }]);
  assert.deepEqual(w.said, ["reply: Assigned this thread to name-of-UWES."]);
  // Nothing stopped: no cancel, no interrupt.
  assert.deepEqual(w.state.stopped, []);
  assert.ok(!w.events.some((e) => e.kind === "request_cancelled"));
  assert.equal(w.requests.length, 1, "no request made of it");
  // The Mission's note, in that thread, with no request of its own.
  assert.equal(w.events.length, 2);
  const note = w.events[1];
  assert.equal(note.kind, "slack_request");
  assert.equal(note.key, "slack_request:assign:Ea");
  assert.deepEqual(note.payload.slack, {
    channel: "C1",
    thread: t.threadTs,
    ts: "1731400060.000100",
    author: "Outrunner",
    text: assignedNote("name-of-UALICE", "name-of-UWES"),
  });
  // Slack's retry: assigned again (the same), told once.
  await routeToMission(msg({ mention: false, text: "!assign <@UWES>", threadTs: t.threadTs, ts: "1731400060.000100", eventId: "Ea" }), w.deps);
  assert.equal(w.events.length, 2);
  // With a mention, and Slack's name in the mention.
  await routeToMission(msg({ text: `<@${BOT}> !assign <@UNORA|nora>`, threadTs: t.threadTs, ts: "1731400061.000100", eventId: "Ea3" }), w.deps);
  assert.equal(w.state.assigned.at(-1)?.assignee, "nora");
  assert.equal(w.said.at(-1), "reply: Assigned this thread to name-of-UNORA.");
});

test("!assign in a thread with nothing open says so and tells the Mission nothing", async () => {
  const w = world();
  await routeToMission(msg(), w.deps);
  const [t] = w.threads;
  await routeToMission(msg({ mention: false, text: "!assign <@UWES>", threadTs: t.threadTs, ts: "1731400070.000100", eventId: "Ez" }), w.deps);
  assert.deepEqual(w.said, ["tell: Nothing is open in this thread to assign."]);
  assert.equal(w.events.length, 1);
});
