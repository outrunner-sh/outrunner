/**
 * Slack → a Mission on call (lib/missions/slack-route.ts): which messages a
 * bound channel's Mission takes, and which go on to the Slack agent; Slack's
 * retries recorded once; the gate (linked, same org, read on the project);
 * the thread keywords, pause, bots, and the exact commands.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { MissionChannel, MissionThread } from "@/lib/missions/slack-store";
import { routeToMission, type SlackRouteDeps, type SlackRouteMessage } from "@/lib/missions/slack-route";
import { onCallCommand, threadKeyword } from "@/lib/missions/slack-text";
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
    { missionId: "m1", orgId: "o1", teamId: "T1", channelId: "C1", boundBy: "wes", listen: "mentions", allowBotMessages: false, paused: false, ...patch.binding },
  ];
  const threads: MissionThread[] = [];
  const missions = new Map<string, Workspace>([["m1", { ...mission("m1"), ...patch.mission } as Workspace], ["m2", mission("m2")]]);
  const events: RecordedEvent[] = [];
  const said: string[] = [];
  const linkedUsers: Record<string, { userId: string; orgId: string }> = {
    UALICE: { userId: "alice", orgId: "o1" },
    UWES: { userId: "wes", orgId: "o1" },
    UBOB: { userId: "bob", orgId: "o2" },
    UNORA: { userId: "nora", orgId: "o1" },
  };
  const levels: Record<string, AccessLevel | null> = { alice: "read", wes: "write", nora: null, bob: "read" };
  const state = { interrupted: 0, bound: [] as string[], created: 0 };
  const deps: SlackRouteDeps = {
    botUserId: BOT,
    binding: async (team, channel) => bindings.find((b) => b.teamId === team && b.channelId === channel) ?? null,
    thread: async (team, channel, ts) => threads.find((t) => t.teamId === team && t.channelId === channel && t.threadTs === ts) ?? null,
    mission: async (id) => missions.get(id) ?? null,
    linked: async (slackUserId) => linkedUsers[slackUserId] ?? null,
    level: async (userId) => levels[userId] ?? null,
    projectName: async () => "web",
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
    interrupt: async () => {
      state.interrupted++;
      return true;
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
      bindings.push({ missionId: input.missionId, orgId: input.orgId, teamId: "T1", channelId: "C2", boundBy: input.boundBy, listen: "mentions", allowBotMessages: false, paused: false });
      return "bound";
    },
    announce: async () => {
      said.push("announced");
    },
  };
  return { deps, events, said, threads, bindings, state };
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
  assert.equal(await routeToMission(msg({ mention: false, text: "also the signup page", ts: "1731400001.000100", threadTs: "1731400000.000100", eventId: "Ev2" }), w.deps), true);
  assert.equal(w.events.length, 2);
  assert.equal(w.events[1].payload.slack?.thread, "1731400000.000100");
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

test("@Outrunner stop interrupts the Mission's turn; stop being on call here unbinds", async () => {
  const w = world();
  await routeToMission(msg({ text: `<@${BOT}> stop` }), w.deps);
  assert.equal(w.state.interrupted, 1);
  await routeToMission(msg({ text: `<@${BOT}> stop being on call here`, eventId: "E2" }), w.deps);
  assert.equal(w.bindings.length, 1, "needs write");
  await routeToMission(msg({ user: "UWES", text: `<@${BOT}> stop being on call here`, eventId: "E3" }), w.deps);
  assert.equal(w.bindings.length, 0);
  assert.equal(w.events.length, 0);
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
