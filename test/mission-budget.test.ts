/**
 * A Mission's budgets (lib/missions/budget.ts, docs/missions.md "Budgets"):
 * reached on what's known plus what reservations hold or left uncertain,
 * never on a guess; the pause lasting to spendPeriod's end, and lifted by
 * rollover or a raised limit; and every way in held while it lasts (Slack,
 * triggers, event delivery, Ship starts), with running Ships going on and
 * held events delivered once after.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { PendingRun } from "@/lib/automations/runs";
import type { SlackWatchEvent } from "@/lib/automations/run-event";
import type { RunCandidate } from "@/lib/db/automation-runs";
import { type MissionRunDeps, type MissionRunOutcome, startMissionRun } from "@/lib/missions/automation-target";
import {
  activePause,
  type BudgetLimits,
  budgetStartRefusal,
  countedUsd,
  decideBudget,
  parseLimit,
  periodsToRead,
} from "@/lib/missions/budget";
import type { MissionEvent } from "@/lib/missions/events";
import { deliverMissionEvents, drainMissionEvents, type OutboxDeps } from "@/lib/missions/outbox";
import type { MissionChannel, MissionRequest, MissionThread } from "@/lib/missions/slack-store";
import { routeToMission, type SlackRouteDeps, type SlackRouteMessage } from "@/lib/missions/slack-route";
import { budgetReachedText } from "@/lib/missions/slack-text";
import { refusalSaid, tellStartRefused } from "@/lib/missions/slack-tools";
import { type MissionSpend, type SpendPeriodKind, spendPeriod, summarizeSpend } from "@/lib/missions/spend";
import { callMissionTool, type MissionToolDeps } from "@/lib/missions/tools";
import type { RecordedEvent } from "@/lib/missions/watch";
import type { Workspace } from "@/lib/runtime/types";

// Wednesday 12 November 2026, 15:00 UTC.
const NOW = new Date("2026-11-12T15:00:00.000Z");

/** A period's spend as summarizeSpend makes it: `known` dollars of
 *  estimated calls, `unknown` calls of unknown cost, and reservations. */
function spend(kind: SpendPeriodKind, s: { known?: number; unknown?: number; held?: number; uncertain?: number } = {}, at = NOW): MissionSpend {
  return summarizeSpend({
    missionId: "m1",
    kind,
    period: spendPeriod(kind, at),
    totals: {
      reportedUsd: 0,
      reportedCalls: 0,
      estimatedUsd: s.known ?? 0,
      estimatedCalls: s.known ? 1 : 0,
      unavailableCalls: s.unknown ?? 0,
      costBases: [],
      tokens: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    intervals: [],
    unreadSessions: 0,
    liability: { heldUsd: s.held ?? 0, uncertainUsd: s.uncertain ?? 0, openReservations: (s.held ? 1 : 0) + (s.uncertain ? 1 : 0) },
    now: at,
  });
}

const limits = (dailyUsd: number | null, weeklyUsd: number | null): BudgetLimits => ({ dailyUsd, weeklyUsd });

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

test("reached on known spend: paused to the end of the UTC day", () => {
  const below = decideBudget({ limits: limits(100, null), day: spend("day", { known: 99.99 }), week: null, now: NOW });
  assert.equal(below.pause, null);
  assert.equal(below.day?.reached, false);
  const at = decideBudget({ limits: limits(100, null), day: spend("day", { known: 100 }), week: null, now: NOW });
  assert.deepEqual(at.pause, { period: "day", until: "2026-11-13T00:00:00.000Z" });
  assert.equal(at.day?.partlyUnknown, false);
  assert.equal(at.day?.countedUsd, 100);
});

test("partly unknown: held and uncertain reservations count with what's known", () => {
  // $60 known, $25 held, $15 uncertain, and calls whose cost isn't known.
  const day = spend("day", { known: 60, unknown: 3, held: 25, uncertain: 15 });
  assert.equal(day.total.coverage, "unavailable");
  assert.equal(day.total.usd, null);
  assert.equal(countedUsd(day), 100);
  const decision = decideBudget({ limits: limits(100, null), day, week: null, now: NOW });
  assert.deepEqual(decision.pause, { period: "day", until: "2026-11-13T00:00:00.000Z" });
  assert.equal(decision.day?.partlyUnknown, true);
  assert.equal(decision.day?.knownUsd, 60);
  assert.equal(decision.day?.reservedUsd, 40);
});

test("not reached when spend is partly unknown but known plus uncertain is below the limit", () => {
  const day = spend("day", { known: 50, unknown: 40, uncertain: 20 });
  const decision = decideBudget({ limits: limits(100, null), day, week: null, now: NOW });
  assert.equal(decision.pause, null);
  assert.equal(decision.day?.reached, false);
  assert.equal(decision.day?.partlyUnknown, true);
  assert.equal(decision.day?.countedUsd, 70);
});

test("the week's limit pauses to Monday 00:00 UTC; both reached, the week's pause wins", () => {
  const weekOnly = decideBudget({ limits: limits(100, 500), day: spend("day", { known: 40 }), week: spend("week", { known: 500 }), now: NOW });
  assert.deepEqual(weekOnly.pause, { period: "week", until: "2026-11-16T00:00:00.000Z" });
  const both = decideBudget({ limits: limits(100, 500), day: spend("day", { known: 120 }), week: spend("week", { known: 600 }), now: NOW });
  assert.deepEqual(both.pause, { period: "week", until: spendPeriod("week", NOW).end.toISOString() });
  // A period with no limit is never read, nor decides anything.
  assert.deepEqual(periodsToRead(limits(null, 500)), ["week"]);
  assert.deepEqual(periodsToRead(limits(100, null)), ["day"]);
  assert.equal(decideBudget({ limits: limits(null, 500), day: spend("day", { known: 9999 }), week: spend("week", { known: 1 }), now: NOW }).pause, null);
});

test("rollover lifts the pause exactly at spendPeriod's end, not a millisecond before", () => {
  for (const kind of ["day", "week"] as const) {
    const end = spendPeriod(kind, NOW).end;
    const row = { paused_period: kind, paused_until: end.toISOString() };
    assert.deepEqual(activePause(row, new Date(end.getTime() - 1)), { period: kind, until: end.toISOString() }, kind);
    assert.equal(activePause(row, end), null, kind);
    // The new period starts empty: the same limits decide afresh.
    assert.equal(spendPeriod(kind, end).start.getTime(), end.getTime());
    const fresh = decideBudget({
      limits: limits(100, 1000),
      day: spend("day", { known: 0 }, end),
      week: spend("week", { known: kind === "day" ? 300 : 0 }, end),
      now: end,
    });
    assert.equal(fresh.pause, null, kind);
  }
  // A day rolling over inside a week still over its limit: paused again, for the week.
  const end = spendPeriod("day", NOW).end;
  const again = decideBudget({ limits: limits(100, 500), day: spend("day", {}, end), week: spend("week", { known: 500 }, end), now: end });
  assert.deepEqual(again.pause, { period: "week", until: spendPeriod("week", end).end.toISOString() });
  // Sunday 23:59:59.999 is the old week; Monday 00:00 the new one.
  const sunday = new Date("2026-11-15T23:59:59.999Z");
  assert.equal(spendPeriod("week", sunday).end.toISOString(), "2026-11-16T00:00:00.000Z");
  assert.equal(spendPeriod("week", new Date("2026-11-16T00:00:00.000Z")).start.toISOString(), "2026-11-16T00:00:00.000Z");
});

test("a limit raised above what's counted clears the pause; lowered to it, pauses", () => {
  const day = spend("day", { known: 100, uncertain: 5 });
  assert.notEqual(decideBudget({ limits: limits(100, null), day, week: null, now: NOW }).pause, null);
  assert.equal(decideBudget({ limits: limits(105.01, null), day, week: null, now: NOW }).pause, null);
  assert.notEqual(decideBudget({ limits: limits(105, null), day, week: null, now: NOW }).pause, null);
  assert.equal(decideBudget({ limits: limits(null, null), day, week: null, now: NOW }).pause, null);
});

test("limits are dollars to the cent, more than $0, or null", () => {
  assert.deepEqual(parseLimit(100, "dailyUsd"), { usd: 100 });
  assert.deepEqual(parseLimit(12.345, "dailyUsd"), { usd: 12.35 });
  assert.deepEqual(parseLimit(null, "dailyUsd"), { usd: null });
  for (const bad of [0, -1, 0.004, "100", Number.NaN, Infinity, 2_000_000, undefined]) {
    assert.ok("error" in parseLimit(bad, "dailyUsd"), String(bad));
  }
});

// ---------------------------------------------------------------------------
// The ways in, held
// ---------------------------------------------------------------------------

/** A budget as budget.deps.ts keeps it: the row's pause, set by a check
 *  that reads the spend, and lifted by rollover or a raised limit. */
function budgetWorld() {
  const state = { clock: NOW, limits: limits(100, null), knownToday: 0, row: { paused_period: null as SpendPeriodKind | null, paused_until: null as string | null } };
  const check = async (): Promise<SpendPeriodKind | null> => {
    const running = activePause(state.row, state.clock);
    if (running) return running.period;
    const decision = decideBudget({ limits: state.limits, day: spend("day", { known: state.knownToday }, state.clock), week: spend("week", { known: state.knownToday }, state.clock), now: state.clock });
    state.row = { paused_period: decision.pause?.period ?? null, paused_until: decision.pause?.until ?? null };
    return decision.pause?.period ?? null;
  };
  /** setMissionBudget: the pause decided with the new limits, in one write. */
  const raise = (next: BudgetLimits) => {
    state.limits = next;
    const decision = decideBudget({ limits: next, day: spend("day", { known: state.knownToday }, state.clock), week: spend("week", { known: state.knownToday }, state.clock), now: state.clock });
    state.row = { paused_period: decision.pause?.period ?? null, paused_until: decision.pause?.until ?? null };
  };
  return { state, check, raise };
}

/** The outbox as claim_mission_delivery keeps it (test/mission-outbox.test.ts). */
function outboxWorld(held: () => Promise<boolean>) {
  let seq = 0;
  const events: (MissionEvent & { key: string; deliveryId: string | null; delivered: boolean })[] = [];
  const deliveries: { id: string; delivered: boolean }[] = [];
  const said: string[] = [];
  const mission = { id: "m1", kind: "mission", status: "ready", ownerId: "alice" } as Workspace;
  const record = (key: string, kind: MissionEvent["kind"] = "finished") => {
    events.push({ id: `e${++seq}`, key, runnerId: "r1", kind, payload: { runner: "r1", response: key }, createdAt: NOW.toISOString(), deliveryId: null, delivered: false });
  };
  const deps: OutboxDeps = {
    claim: async () => {
      const open = deliveries.find((d) => !d.delivered);
      if (open) return { deliveryId: open.id, attempt: 2 };
      const waiting = events.filter((e) => !e.deliveryId && !e.delivered);
      if (!waiting.length) return null;
      const d = { id: `d${++seq}`, delivered: false };
      deliveries.push(d);
      for (const e of waiting) e.deliveryId = d.id;
      return { deliveryId: d.id, attempt: 1 };
    },
    eventsOf: async (id) => events.filter((e) => e.deliveryId === id),
    session: async () => mission,
    send: async (_m, text) => {
      said.push(text);
    },
    complete: async (id) => {
      deliveries.find((d) => d.id === id)!.delivered = true;
      for (const e of events.filter((x) => x.deliveryId === id)) e.delivered = true;
    },
    fail: async () => undefined,
    held,
  };
  return { deps, record, said, events, deliveries };
}

test("budget-paused, a Ship's events are held, never dropped, and delivered once when a raised limit lifts it", async () => {
  const b = budgetWorld();
  b.state.knownToday = 100;
  const o = outboxWorld(async () => (await b.check()) !== null);
  o.record("ship finished");
  o.record("pr ready", "ready");
  assert.equal(await deliverMissionEvents("m1", o.deps), "held");
  assert.equal(await drainMissionEvents("m1", o.deps), 0);
  // Nothing claimed: the batch is whole for later, and nothing was dropped.
  assert.equal(o.deliveries.length, 0);
  assert.deepEqual(o.said, []);
  assert.equal(o.events.filter((e) => !e.delivered).length, 2);
  // The limit raised: the pause lifted in that write, and the held events go.
  b.raise(limits(200, null));
  assert.equal(b.state.row.paused_period, null);
  assert.equal(await drainMissionEvents("m1", o.deps), 1);
  assert.equal(o.said.length, 1);
  assert.match(o.said[0], /ship finished/);
  assert.match(o.said[0], /kind="ready"/);
  // Exactly once: nothing more goes.
  assert.equal(await drainMissionEvents("m1", o.deps), 0);
  assert.equal(o.said.length, 1);
});

test("budget-paused for the day, events go at rollover, not a millisecond before", async () => {
  const b = budgetWorld();
  b.state.knownToday = 150;
  const o = outboxWorld(async () => (await b.check()) !== null);
  o.record("answer", "slack_answer");
  assert.equal(await deliverMissionEvents("m1", o.deps), "held");
  const end = spendPeriod("day", NOW).end;
  b.state.clock = new Date(end.getTime() - 1);
  assert.equal(await deliverMissionEvents("m1", o.deps), "held");
  // A new day: its spend starts at nothing.
  b.state.clock = end;
  b.state.knownToday = 0;
  assert.equal(await deliverMissionEvents("m1", o.deps), "delivered");
  assert.equal(o.said.length, 1);
  assert.equal(b.state.row.paused_until, null);
});

// Slack ----------------------------------------------------------------------

const BOT = "UBOT";

function slackWorld(budget: SpendPeriodKind | null) {
  const binding: MissionChannel = { missionId: "m1", orgId: "o1", teamId: "T1", channelId: "C1", boundBy: "wes", listen: "mentions", allowBotMessages: false, paused: false, revision: "rev1" };
  const thread: MissionThread = { id: "t1", missionId: "m1", teamId: "T1", channelId: "C1", threadTs: "1731400000.000100", permalink: null, startedBy: "alice", startedBySlack: "UALICE", lastRequestTs: null, muted: false };
  const mission = { id: "m1", kind: "mission", status: "ready", ownerId: "owner", projectId: "p1", environmentId: "env1" } as Workspace;
  const events: RecordedEvent[] = [];
  const requests: MissionRequest[] = [];
  const said: string[] = [];
  const nope = async (): Promise<never> => {
    throw new Error("not used");
  };
  const deps: SlackRouteDeps = {
    botUserId: BOT,
    newThreadRequest: async () => "queued",
    assignThread: async () => 0,
    binding: async () => binding,
    thread: async (_t, _c, ts) => (ts === thread.threadTs ? thread : null),
    mission: async () => mission,
    linked: async (user) => (user === "UALICE" ? { userId: "alice", orgId: "o1" } : null),
    level: async () => "read",
    projectName: async () => "web",
    acceptThread: async () => thread,
    recordRequest: async (r) => {
      requests.push(r);
    },
    setMuted: nope,
    setPaused: nope,
    unbind: nope,
    budgetPause: async () => budget,
    enqueue: async (e) => {
      events.push(e);
      return true;
    },
    stopThread: nope,
    name: async () => "Alice",
    permalink: async () => null,
    reply: async (_ts, text) => {
      said.push(`reply: ${text}`);
    },
    tell: async (_ts, text) => {
      said.push(`tell: ${text}`);
    },
    askToConnect: nope,
    findProject: nope,
    projectLevel: nope,
    localChannel: nope,
    freeMissions: nope,
    createMission: nope,
    bind: nope,
    announce: nope,
  };
  return { deps, events, requests, said };
}

const mention = (patch: Partial<SlackRouteMessage> = {}): SlackRouteMessage => ({
  teamId: "T1",
  channel: "C1",
  user: "UALICE",
  text: `<@${BOT}> the deploy is failing`,
  ts: "1731400100.000100",
  mention: true,
  eventId: "Ev1",
  ...patch,
});

test("a Slack request to a budget-paused Mission gets the one fixed reply, and nothing reaches it", async () => {
  const w = slackWorld("day");
  assert.equal(await routeToMission(mention(), w.deps), true);
  assert.deepEqual(w.said, [
    "reply: The Mission's budget for today is reached, so it didn't take that. It goes on when the day rolls over or someone raises its budget.",
  ]);
  assert.deepEqual(w.events, []);
  assert.deepEqual(w.requests, []);
  // A reply in its thread, no mention: told to the sender alone.
  const reply = slackWorld("week");
  await routeToMission(mention({ text: "any news?", mention: false, threadTs: "1731400000.000100", ts: "1731400200.000100", eventId: "Ev2" }), reply.deps);
  assert.deepEqual(reply.said, [`tell: ${budgetReachedText("week")}`]);
  assert.match(budgetReachedText("week"), /budget for this week is reached.*when the week rolls over/);
  assert.deepEqual(reply.events, []);
  // Never a dollar figure.
  for (const text of [budgetReachedText("day"), budgetReachedText("week")]) assert.doesNotMatch(text, /\$|\d/);
  // Not paused: taken as ever.
  const open = slackWorld(null);
  await routeToMission(mention(), open.deps);
  assert.equal(open.events.length, 1);
  assert.equal(open.events[0].kind, "slack_request");
});

// Triggers -------------------------------------------------------------------

test("a trigger's run while budget-paused is recorded, skipped and says why; no request, no filter call", async () => {
  const requests: unknown[] = [];
  const settled: MissionRunOutcome[] = [];
  let filtered = 0;
  const deps: MissionRunDeps = {
    mission: async () => ({ id: "m1", kind: "mission", status: "ready", ownerId: "owner", projectId: "p1" }) as Workspace,
    binding: async () => null,
    delegationApproved: async () => true,
    ownerCanRead: async () => true,
    filter: async () => {
      filtered++;
      return '{"match": true, "reason": "x"}';
    },
    claimMessage: async () => true,
    createRequest: async (input) => {
      requests.push(input);
      return "created";
    },
    settleRun: async (_id, outcome) => {
      settled.push(outcome);
    },
    budgetPause: async () => "day",
  };
  const candidate = {
    automationId: "auto1",
    name: "Triage",
    prompt: "Triage it.",
    triggers: ["slack.message"],
    orgId: "o1",
    target: { kind: "mission", missionId: "m1", watch: { teamId: "T1", channelId: "C9", filterPrompt: "bugs", allowedAppIds: [] }, linearTeamIds: [] },
  } as unknown as RunCandidate;
  const event: SlackWatchEvent = { trigger: "slack.message", teamId: "T1", channelId: "C9", ts: "1.2", user: "U1", text: "500s" };
  const run: PendingRun = { runId: "run1", candidate, event };
  const outcome = await startMissionRun(run, deps);
  assert.equal(outcome.status, "skipped");
  assert.match(outcome.reason ?? "", /budget for today is reached: nothing was sent to it/);
  assert.deepEqual(settled, [outcome]);
  assert.deepEqual(requests, []);
  assert.equal(filtered, 0);
  // Lifted: the next run goes as ever.
  const ready = await startMissionRun(run, { ...deps, budgetPause: async () => null });
  assert.equal(ready.status, "ready");
  assert.equal(requests.length, 1);
});

// Ship starts ----------------------------------------------------------------

function toolWorld(budget: () => SpendPeriodKind | null) {
  const ship = { id: "r1", kind: "session", parentMissionId: "m1", status: "ready", ownerId: "alice" } as Workspace;
  const sessions = [{ id: "m1", kind: "mission", status: "ready", ownerId: "alice" } as Workspace, ship];
  const started: string[] = [];
  const sent: string[] = [];
  const deps: MissionToolDeps = {
    access: async () => null,
    environmentReady: async () => null,
    session: async (id) => sessions.find((s) => s.id === id) ?? null,
    runners: async (missionId) => sessions.filter((s) => s.parentMissionId === missionId),
    working: async () => false,
    latestResponse: async () => null,
    pullRequests: async () => [],
    startRunner: async (_m, start) => {
      started.push(start.brief);
      return { runnerId: "r2" };
    },
    send: async (runner, content) => {
      sent.push(`${runner.id}: ${content}`);
      return true;
    },
    queue: async () => undefined,
    queued: async () => new Map(),
    archive: async () => true,
    readNotes: async () => ({ body: "", updatedAt: null }),
    writeNotes: async () => undefined,
    budgetPause: async () => budget(),
  };
  return { deps, started, sent };
}

test("a Ship start is refused with the budget's message while budget-paused; running Ships go on", async () => {
  let budget: SpendPeriodKind | null = "day";
  const w = toolWorld(() => budget);
  const refused = await callMissionTool({ missionId: "m1" }, "spawn_runner", { prompt: "Fix the login page" }, w.deps);
  assert.equal(refused.isError, true);
  assert.equal(refused.text, `The Ship didn't start: ${budgetStartRefusal("day")}.`);
  assert.match(refused.text, /budget for today is reached, so it starts no Ship until the day rolls over or someone raises its budget/);
  assert.deepEqual(w.started, []);
  // A Ship already running still takes the Mission's messages.
  const steered = await callMissionTool({ missionId: "m1" }, "message_runner", { runner_id: "r1", message: "also check Safari" }, w.deps);
  assert.equal(steered.isError, undefined);
  assert.deepEqual(w.sent, ["r1: also check Safari"]);
  // Lifted: it starts.
  budget = null;
  const ok = await callMissionTool({ missionId: "m1" }, "spawn_runner", { prompt: "Fix the login page" }, w.deps);
  assert.equal(ok.isError, undefined);
  assert.deepEqual(w.started, ["Fix the login page"]);
});

test("the thread hears 'budget reached' apart from 'plan has no room', never a dollar figure", async () => {
  const budget = refusalSaid(budgetStartRefusal("week"));
  const plan = refusalSaid("You've reached your plan's limit of 2 concurrent cloud sessions.");
  const usage = refusalSaid("Your org's cloud usage limit of $50 is reached.");
  assert.equal(budget, "The Mission's budget for this week is reached.");
  assert.equal(plan, "The Mission owner's plan has no room for another cloud session right now.");
  assert.notEqual(budget, plan);
  assert.notEqual(budget, usage);
  const queued: string[] = [];
  const binding: MissionChannel = { missionId: "m1", orgId: "o1", teamId: "T1", channelId: "C1", boundBy: "wes", listen: "mentions", allowBotMessages: false, paused: false, revision: "rev1" };
  const thread: MissionThread = { id: "t1", missionId: "m1", teamId: "T1", channelId: "C1", threadTs: "1.1", permalink: null, startedBy: "alice", startedBySlack: null, lastRequestTs: null, muted: false };
  await tellStartRefused({ spawnKey: "k1", binding, thread, request: null }, budgetStartRefusal("day"), {
    queue: async (post) => {
      queued.push(...(post.payload as { chunks: string[] }).chunks);
      return "queued";
    },
  });
  assert.equal(queued.length, 1);
  assert.match(queued[0], /The Mission's budget for today is reached\./);
  assert.doesNotMatch(queued[0], /\$|plan has no room/);
});
