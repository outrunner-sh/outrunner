/**
 * Idle pause (lib/missions/idle-pause.ts, docs/missions.md "Idle pause"): no
 * offer before 2 weeks, one at 2 weeks however many ticks race, a human's
 * reply calling it off, the pause 24 hours on with its exact words, bots not
 * counting, resume clearing it, and a binding paused by a person left alone.
 * The database's own statements: test/mission-idle-pause-sql.test.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { IDLE_AFTER_MS, IDLE_GRACE_MS, idleStep, sweepIdle, type IdleSweepDeps } from "@/lib/missions/idle-pause";
import type { MissionChannel, MissionThread } from "@/lib/missions/slack-store";
import { routeToMission, type SlackRouteDeps, type SlackRouteMessage } from "@/lib/missions/slack-route";
import { IDLE_OFFER_TEXT, IDLE_PAUSE_TEXT } from "@/lib/missions/slack-text";
import type { AccessLevel } from "@/lib/orgs/access";
import type { Workspace } from "@/lib/runtime/types";

const BOT = "UBOT";
const DAY = 24 * 60 * 60_000;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms);
const iso = (ms: number) => at(ms).toISOString();

function binding(patch: Partial<MissionChannel> = {}): MissionChannel {
  return {
    missionId: "m1",
    orgId: "o1",
    teamId: "T1",
    channelId: "C1",
    boundBy: "wes",
    listen: "mentions",
    allowBotMessages: false,
    paused: false,
    revision: "rev1",
    lastHumanAt: iso(0),
    idleWarnedAt: null,
    idlePaused: false,
    ...patch,
  };
}

/** The bindings and the channel, as the database keeps them: each step
 *  marks what's due and queues its post at once, as the SQL does. */
function store(bindings: MissionChannel[]) {
  const clock = { now: T0 };
  const posts: { opKey: string; missionId: string; text: string }[] = [];
  const audits: string[] = [];
  const facts = (b: MissionChannel) => ({ paused: b.paused, lastHumanAt: b.lastHumanAt!, idleWarnedAt: b.idleWarnedAt ?? null });
  const queue = (b: MissionChannel, kind: string, text: string) => {
    const opKey = `${kind}:${b.revision}:${Date.parse(b.idleWarnedAt!)}`;
    if (!posts.some((p) => p.opKey === opKey)) posts.push({ opKey, missionId: b.missionId, text });
  };
  const deps: IdleSweepDeps = {
    offer: async () => {
      await Promise.resolve();
      const due = bindings.filter((b) => idleStep(facts(b), new Date(clock.now)) === "offer");
      for (const b of due) {
        b.idleWarnedAt = new Date(clock.now).toISOString();
        queue(b, "idle_offer", IDLE_OFFER_TEXT);
      }
      return due.map((b) => ({ ...b }));
    },
    pause: async () => {
      await Promise.resolve();
      const due = bindings.filter((b) => idleStep(facts(b), new Date(clock.now)) === "pause");
      for (const b of due) {
        b.paused = true;
        b.idlePaused = true;
        queue(b, "idle_pause", IDLE_PAUSE_TEXT);
      }
      return due.map((b) => ({ ...b }));
    },
    audit: async (b) => {
      audits.push(b.missionId);
    },
    log: () => undefined,
  };
  /** What slack-store's heardHuman does. */
  const heard = (b: MissionChannel) => {
    b.lastHumanAt = new Date(clock.now).toISOString();
    b.idleWarnedAt = null;
  };
  /** What slack-store's setChannelPaused does. */
  const setPaused = (b: MissionChannel, paused: boolean) => {
    b.paused = paused;
    b.idlePaused = false;
    b.idleWarnedAt = null;
    if (!paused) b.lastHumanAt = new Date(clock.now).toISOString();
  };
  return { deps, posts, audits, clock, heard, setPaused };
}

test("idleStep: the offer at 2 weeks, not a moment before; the pause 24 hours on", () => {
  const b = { paused: false, lastHumanAt: iso(0), idleWarnedAt: null };
  assert.equal(idleStep(b, at(IDLE_AFTER_MS - 1)), "none");
  assert.equal(idleStep(b, at(IDLE_AFTER_MS)), "offer");
  const offered = { ...b, idleWarnedAt: iso(IDLE_AFTER_MS) };
  assert.equal(idleStep(offered, at(IDLE_AFTER_MS + IDLE_GRACE_MS - 1)), "none");
  assert.equal(idleStep(offered, at(IDLE_AFTER_MS + IDLE_GRACE_MS)), "pause");
  // A human since the offer (last_human_at past it): no pause.
  assert.equal(idleStep({ ...offered, lastHumanAt: iso(IDLE_AFTER_MS + 1) }, at(IDLE_AFTER_MS + 2 * IDLE_GRACE_MS)), "none");
  // Paused by a person: never swept.
  assert.equal(idleStep({ ...b, paused: true }, at(100 * DAY)), "none");
  assert.equal(idleStep({ ...offered, paused: true }, at(100 * DAY)), "none");
});

test("no offer before 2 weeks; one at 2 weeks, once, however many ticks race", async () => {
  const b = binding();
  const s = store([b]);
  s.clock.now = T0 + 13 * DAY;
  assert.deepEqual(await sweepIdle(s.deps), { offered: 0, paused: 0 });
  assert.equal(s.posts.length, 0);

  s.clock.now = T0 + 14 * DAY;
  const results = await Promise.all([sweepIdle(s.deps), sweepIdle(s.deps), sweepIdle(s.deps)]);
  assert.equal(results.reduce((n, r) => n + r.offered, 0), 1);
  assert.deepEqual(s.posts.map((p) => p.text), [IDLE_OFFER_TEXT]);
  assert.equal(b.idleWarnedAt, iso(14 * DAY));
  // A retried tick an hour on: nothing new.
  s.clock.now += 60 * 60_000;
  assert.deepEqual(await sweepIdle(s.deps), { offered: 0, paused: 0 });
  assert.equal(s.posts.length, 1);
});

test("a human's reply before the 24 hours calls the offer off: no pause, and 2 more weeks", async () => {
  const b = binding();
  const s = store([b]);
  s.clock.now = T0 + 14 * DAY;
  await sweepIdle(s.deps);
  s.clock.now += 23 * 60 * 60_000;
  s.heard(b);
  assert.equal(b.idleWarnedAt, null);
  s.clock.now += 2 * DAY;
  assert.deepEqual(await sweepIdle(s.deps), { offered: 0, paused: 0 });
  assert.equal(b.paused, false);
  assert.equal(s.posts.length, 1);
});

test("the pause 24 hours after the offer, with its exact words, audited, once", async () => {
  const b = binding();
  const s = store([b]);
  s.clock.now = T0 + 14 * DAY;
  await sweepIdle(s.deps);
  s.clock.now += IDLE_GRACE_MS - 60_000;
  assert.deepEqual(await sweepIdle(s.deps), { offered: 0, paused: 0 });
  s.clock.now += 60_000;
  const results = await Promise.all([sweepIdle(s.deps), sweepIdle(s.deps)]);
  assert.equal(results.reduce((n, r) => n + r.paused, 0), 1);
  assert.equal(b.paused, true);
  assert.equal(b.idlePaused, true);
  assert.equal(s.posts[1].text, "Paused: no one has replied for 2 weeks. @Outrunner resume to continue.");
  assert.equal(IDLE_PAUSE_TEXT, "Paused: no one has replied for 2 weeks. @Outrunner resume to continue.");
  assert.deepEqual(s.audits, ["m1"]);
  // Weeks on, still paused: nothing more is posted.
  s.clock.now += 30 * DAY;
  assert.deepEqual(await sweepIdle(s.deps), { offered: 0, paused: 0 });
  assert.equal(s.posts.length, 2);
});

test("resume clears the idle pause and starts the 2 weeks again", async () => {
  const b = binding();
  const s = store([b]);
  s.clock.now = T0 + 14 * DAY;
  await sweepIdle(s.deps);
  s.clock.now += IDLE_GRACE_MS;
  await sweepIdle(s.deps);
  assert.equal(b.idlePaused, true);
  s.clock.now += 5 * DAY;
  s.setPaused(b, false);
  assert.deepEqual({ paused: b.paused, idlePaused: b.idlePaused, idleWarnedAt: b.idleWarnedAt, lastHumanAt: b.lastHumanAt }, {
    paused: false,
    idlePaused: false,
    idleWarnedAt: null,
    lastHumanAt: new Date(s.clock.now).toISOString(),
  });
  s.clock.now += 13 * DAY;
  assert.deepEqual(await sweepIdle(s.deps), { offered: 0, paused: 0 });
  s.clock.now += DAY;
  assert.deepEqual(await sweepIdle(s.deps), { offered: 1, paused: 0 });
});

test("a binding a person paused isn't swept, offered or not", async () => {
  const quiet = binding({ paused: true, lastHumanAt: iso(0) });
  const offered = binding({ missionId: "m2", channelId: "C2", revision: "rev2", lastHumanAt: iso(0), idleWarnedAt: iso(0) });
  const s = store([quiet, offered]);
  // A person pauses during the offer: no idle pause follows.
  s.setPaused(offered, true);
  s.clock.now = T0 + 60 * DAY;
  assert.deepEqual(await sweepIdle(s.deps), { offered: 0, paused: 0 });
  assert.equal(s.posts.length, 0);
  assert.equal(quiet.idlePaused, false);
  assert.equal(offered.idlePaused, false);
});

test("an audit that fails doesn't stop the sweep", async () => {
  const b = binding({ lastHumanAt: iso(0), idleWarnedAt: iso(14 * DAY) });
  const s = store([b]);
  const logged: string[] = [];
  s.clock.now = T0 + 16 * DAY;
  const result = await sweepIdle({
    ...s.deps,
    audit: async () => {
      throw new Error("audit down");
    },
    log: (message) => logged.push(message),
  });
  assert.deepEqual(result, { offered: 0, paused: 1 });
  assert.equal(logged.length, 1);
});

// The router: what moves last_human_at.

function mission(id: string): Workspace {
  return { id, kind: "mission", status: "ready", ownerId: "owner", projectId: "p1", environmentId: "env1", title: `Mission ${id}`, branch: "b" } as Workspace;
}

/** C1 bound to m1 (an offer pending); Alice linked with read, Wes with
 *  write, Una not linked. Threads 100.1 and 110.1 (muted) are m1's; 200.1
 *  is its idle offer. */
function world(patch: Partial<MissionChannel> = {}) {
  const b = binding({ idleWarnedAt: iso(14 * DAY), ...patch });
  const threads: MissionThread[] = [
    { id: "t1", missionId: "m1", teamId: "T1", channelId: "C1", threadTs: "100.1", permalink: null, startedBy: "alice", startedBySlack: "UALICE", lastRequestTs: "100.1", muted: false },
    { id: "t2", missionId: "m1", teamId: "T1", channelId: "C1", threadTs: "110.1", permalink: null, startedBy: "alice", startedBySlack: "UALICE", lastRequestTs: "110.1", muted: true },
  ];
  const heard: string[] = [];
  const paused: boolean[] = [];
  const linked: Record<string, { userId: string; orgId: string }> = { UALICE: { userId: "alice", orgId: "o1" }, UWES: { userId: "wes", orgId: "o1" } };
  const levels: Record<string, AccessLevel> = { alice: "read", wes: "write" };
  const deps: SlackRouteDeps = {
    botUserId: BOT,
    binding: async (team, channel) => (team === b.teamId && channel === b.channelId ? b : null),
    thread: async (_team, _channel, ts) => threads.find((t) => t.threadTs === ts) ?? null,
    mission: async (id) => mission(id),
    linked: async (u) => linked[u] ?? null,
    level: async (userId) => levels[userId] ?? null,
    projectName: async () => "web",
    acceptThread: async () => threads[0],
    recordRequest: async () => undefined,
    setMuted: async () => undefined,
    setPaused: async (_m, p) => {
      paused.push(p);
      b.paused = p;
      b.idlePaused = false;
      b.idleWarnedAt = null;
    },
    unbind: async () => undefined,
    enqueue: async () => true,
    stopThread: async () => ({ requests: 0, ships: 0 }),
    heardHuman: async (x) => {
      heard.push(x.missionId);
      x.idleWarnedAt = null;
    },
    idleOfferThread: async (_x, ts) => ts === "200.1",
    name: async (id) => id,
    permalink: async () => null,
    reply: async () => undefined,
    tell: async () => undefined,
    askToConnect: async () => undefined,
    findProject: async () => null,
    projectLevel: async () => null,
    localChannel: async () => true,
    freeMissions: async () => [],
    createMission: async () => ({ error: "no" }),
    bind: async () => "bound",
    announce: async () => undefined,
  };
  return { b, deps, heard, paused };
}

function msg(patch: Partial<SlackRouteMessage> = {}): SlackRouteMessage {
  return { teamId: "T1", channel: "C1", user: "UALICE", text: `<@${BOT}> fix the login bug`, ts: "300.1", mention: true, eventId: "Ev1", ...patch };
}

test("a human's mention, or reply in the Mission's thread, is heard and calls off the offer", async () => {
  const w = world();
  await routeToMission(msg(), w.deps);
  assert.deepEqual(w.heard, ["m1"]);
  assert.equal(w.b.idleWarnedAt, null);
  const v = world();
  await routeToMission(msg({ mention: false, text: "any news?", threadTs: "100.1" }), v.deps);
  assert.deepEqual(v.heard, ["m1"]);
});

test("a mention counts, linked or not, paused or not; a mention alone doesn't resume", async () => {
  for (const m of [msg(), msg({ user: "UUNA" }), msg({ threadTs: "100.1" })]) {
    const w = world();
    await routeToMission(m, w.deps);
    assert.deepEqual(w.heard, ["m1"], m.user);
    assert.equal(w.b.idleWarnedAt, null, "the offer is called off");
  }
  const p = world({ paused: true, idlePaused: true });
  await routeToMission(msg(), p.deps);
  assert.deepEqual(p.heard, ["m1"]);
  assert.equal(p.b.paused, true, "a mention alone doesn't resume it");
});

test("!aside and a muted thread are people talking to each other: the offer stands", async () => {
  for (const m of [
    msg({ mention: false, text: "!aside just us", threadTs: "100.1" }),
    msg({ text: `<@${BOT}> !aside not for you` }),
    msg({ mention: false, text: "!aside under the offer", threadTs: "200.1" }),
    msg({ mention: false, text: "talking among ourselves", threadTs: "110.1" }),
    msg({ text: `<@${BOT}> are you there?`, threadTs: "110.1" }),
    msg({ mention: false, text: "!unmute", threadTs: "110.1", user: "UWES" }),
  ]) {
    const w = world();
    await routeToMission(m, w.deps);
    assert.deepEqual(w.heard, [], m.text);
    assert.equal(w.b.idleWarnedAt, iso(14 * DAY), m.text);
  }
});

test("a reply under the idle offer answers it, and isn't passed on to the Slack agent", async () => {
  const w = world();
  assert.equal(await routeToMission(msg({ mention: false, text: "still here", threadTs: "200.1" }), w.deps), true);
  assert.deepEqual(w.heard, ["m1"]);
  // With no offer pending, that thread is any other: the agent's.
  const v = world({ idleWarnedAt: null });
  assert.equal(await routeToMission(msg({ mention: false, text: "still here", threadTs: "200.1" }), v.deps), false);
  assert.deepEqual(v.heard, []);
});

test("bots don't count, Outrunner's own messages least of all; nor does what it doesn't hear", async () => {
  for (const m of [
    msg({ botId: "B1", user: "UOTHERBOT" }),
    msg({ botId: "B1", user: "UOTHERBOT", mention: false, threadTs: "100.1", text: "deploy done" }),
    msg({ botId: "B1", user: "UOTHERBOT", mention: false, threadTs: "200.1", text: "beep" }),
    msg({ user: BOT, mention: false, threadTs: "100.1", text: "On it." }),
    // A channel message with no mention, outside its threads.
    msg({ mention: false, text: "lunch?" }),
  ]) {
    const w = world();
    await routeToMission(m, w.deps);
    assert.deepEqual(w.heard, [], m.text);
    assert.equal(w.b.idleWarnedAt, iso(14 * DAY), m.text);
  }
  // Even a bot the channel takes.
  const w = world({ allowBotMessages: true });
  await routeToMission(msg({ botId: "B1", user: "UOTHERBOT" }), w.deps);
  assert.deepEqual(w.heard, []);
});

test("@Outrunner resume on an idle-paused Mission resumes it, clearing idle state", async () => {
  const w = world({ paused: true, idlePaused: true });
  await routeToMission(msg({ user: "UWES", text: `<@${BOT}> resume` }), w.deps);
  assert.deepEqual(w.paused, [false]);
  assert.equal(w.b.paused, false);
  assert.equal(w.b.idlePaused, false);
});

test("a failure noting the human never gets in the way of the message", async () => {
  const w = world();
  w.deps.heardHuman = async () => {
    throw new Error("db down");
  };
  const original = console.error;
  console.error = () => undefined;
  try {
    assert.equal(await routeToMission(msg(), w.deps), true);
  } finally {
    console.error = original;
  }
});
