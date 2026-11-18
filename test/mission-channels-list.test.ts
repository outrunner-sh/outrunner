/**
 * Where a Mission stands on call (lib/missions/on-call-state.ts) and
 * Settings' list of bound channels (lib/missions/mission-channels-list.ts):
 * the one state named, budget first; the list scoped to the org and to
 * Missions whose project the viewer can read; Disconnect for write alone,
 * through the off-call path.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { boundByName, type ChannelListDeps, type DisconnectDeps, disconnectBoundChannel, listBoundChannels } from "@/lib/missions/mission-channels-list";
import {
  ON_CALL_STATE_LABEL,
  type OnCallFacts,
  needsAttention,
  onCallBadge,
  onCallState,
  onCallTooltip,
} from "@/lib/missions/on-call-state";
import type { BoundChannelRow, MissionChannel } from "@/lib/missions/slack-store";
import type { AccessLevel } from "@/lib/orgs/access";
import type { Workspace } from "@/lib/runtime/types";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const LATER = "2026-11-16T00:00:00Z";
const EARLIER = "2026-11-15T00:00:00Z";

const facts = (patch: Partial<OnCallFacts> = {}): OnCallFacts => ({
  bound: true,
  paused: false,
  idlePaused: false,
  budgetPausedUntil: null,
  budgetPausedPeriod: null,
  ...patch,
});

test("state: on call, paused, idle-paused, budget-paused, each alone", () => {
  assert.equal(onCallState(facts(), NOW), "on_call");
  assert.equal(onCallState(facts({ paused: true }), NOW), "paused");
  assert.equal(onCallState(facts({ paused: true, idlePaused: true }), NOW), "idle_paused");
  assert.equal(onCallState(facts({ budgetPausedUntil: LATER, budgetPausedPeriod: "day" }), NOW), "budget_paused");
});

test("state: budget beats idle beats a person's pause", () => {
  assert.equal(onCallState(facts({ paused: true, idlePaused: true, budgetPausedUntil: LATER }), NOW), "budget_paused");
  assert.equal(onCallState(facts({ paused: true, budgetPausedUntil: LATER }), NOW), "budget_paused");
  // An idle pause is named for why, even if `paused` wasn't set with it.
  assert.equal(onCallState(facts({ idlePaused: true }), NOW), "idle_paused");
});

test("state: a budget pause that's over counts for nothing; one that isn't counts unbound too", () => {
  assert.equal(onCallState(facts({ budgetPausedUntil: EARLIER, budgetPausedPeriod: "week" }), NOW), "on_call");
  assert.equal(onCallState(facts({ paused: true, budgetPausedUntil: EARLIER }), NOW), "paused");
  assert.equal(onCallState(facts({ budgetPausedUntil: new Date(NOW).toISOString() }), NOW), "on_call");
  assert.equal(onCallState(facts({ budgetPausedUntil: "not a date" }), NOW), "on_call");
  assert.equal(onCallState(facts({ bound: false }), NOW), null);
  assert.equal(onCallState(facts({ bound: false, paused: true, idlePaused: true }), NOW), null);
  assert.equal(onCallState(facts({ bound: false, budgetPausedUntil: LATER }), NOW), "budget_paused");
});

test("attention: every pause, never plain on call", () => {
  assert.equal(needsAttention("on_call"), false);
  assert.equal(needsAttention(null), false);
  for (const state of ["paused", "idle_paused", "budget_paused"] as const) assert.equal(needsAttention(state), true);
});

test("tooltip: names which pause, and the budget's period and end", () => {
  const none = { budgetPausedUntil: null, budgetPausedPeriod: null };
  assert.match(onCallTooltip("paused", none), /^Paused in Slack: /);
  assert.match(onCallTooltip("idle_paused", none), /^Idle-paused: no one replied/);
  assert.equal(onCallTooltip("on_call", none), "On call in Slack");
  assert.match(onCallTooltip("budget_paused", { budgetPausedUntil: LATER, budgetPausedPeriod: "day" }), /^Budget-paused: its daily budget is spent\. Nothing runs until .+, or until the budget is raised\.$/);
  assert.match(onCallTooltip("budget_paused", { budgetPausedUntil: LATER, budgetPausedPeriod: "week" }), /its weekly budget/);
  assert.match(onCallTooltip("budget_paused", none), /^Budget-paused: its budget is spent\. Nothing runs, or until/);
  for (const state of ["paused", "idle_paused", "budget_paused"] as const) {
    assert.ok(onCallTooltip(state, none).startsWith(ON_CALL_STATE_LABEL[state]), state);
  }
});

test("badge: none without facts or state; a mark on call; a badge with its tooltip when paused", () => {
  assert.equal(onCallBadge(undefined, NOW), null);
  assert.equal(onCallBadge(facts({ bound: false }), NOW), null);
  assert.deepEqual(onCallBadge(facts(), NOW), { state: "on_call", tooltip: "On call in Slack", attention: false });
  const idle = onCallBadge(facts({ paused: true, idlePaused: true }), NOW);
  assert.equal(idle?.state, "idle_paused");
  assert.equal(idle?.attention, true);
  assert.match(idle?.tooltip ?? "", /^Idle-paused/);
  const budget = onCallBadge(facts({ bound: false, budgetPausedUntil: LATER, budgetPausedPeriod: "day" }), NOW);
  assert.equal(budget?.state, "budget_paused");
  assert.match(budget?.tooltip ?? "", /^Budget-paused/);
});

// The list.

const row = (missionId: string, patch: Partial<BoundChannelRow> = {}): BoundChannelRow => ({
  missionId,
  orgId: "org1",
  teamId: "T1",
  channelId: `C${missionId}`,
  boundBy: "wes",
  boundAt: "2026-11-10T09:00:00Z",
  paused: false,
  idlePaused: false,
  ...patch,
});
const mission = (id: string, patch: Partial<Workspace> = {}) =>
  ({ id, kind: "mission", orgId: "org1", title: `Mission ${id}`, branch: `b-${id}`, environmentId: `env-${id}`, projectId: `p-${id}`, ...patch }) as Workspace;

function listWorld(opts: {
  bound: { row: BoundChannelRow; budget: { until: string | null; period: "day" | "week" | null } | null }[];
  missions: Workspace[];
  levels: Record<string, AccessLevel | null>;
}) {
  const asked: string[] = [];
  const deps: ChannelListDeps = {
    bound: async () => opts.bound,
    missions: async (ids) => opts.missions.filter((m) => ids.includes(m.id)),
    level: async (userId, m) => {
      asked.push(`${userId}:${m.id}`);
      return opts.levels[m.id] ?? null;
    },
    projectName: async (m) => `Project ${m.id}`,
    people: async (ids) => new Map(ids.map((id) => [id, `@${id}`])),
    slackNames: async () => ({ teams: new Map([["T1", "Acme"]]), channels: new Map([["T1:Cm1", "ops"]]) }),
    now: () => NOW,
  };
  return { deps, asked };
}

test("list: a member sees the org's channels whose project they can read; Disconnect with write only", async () => {
  const { deps } = listWorld({
    bound: [
      { row: row("m1"), budget: null },
      { row: row("m2", { paused: true }), budget: null },
      { row: row("m3"), budget: null },
    ],
    missions: [mission("m1"), mission("m2"), mission("m3")],
    levels: { m1: "write", m2: "read", m3: null },
  });
  const list = await listBoundChannels("viewer", "org1", deps);
  assert.deepEqual(
    list.map((c) => [c.missionId, c.state, c.canDisconnect]),
    [
      ["m1", "on_call", true],
      ["m2", "paused", false],
    ],
  );
  const first = list[0];
  assert.equal(first.channelName, "ops");
  assert.equal(first.teamName, "Acme");
  assert.equal(first.missionTitle, "Mission m1");
  assert.equal(first.project, "Project m1");
  assert.equal(first.boundBy, "@wes");
  assert.equal(first.boundAt, "2026-11-10T09:00:00Z");
  // No name from Slack: the id stands.
  assert.equal(list[1].channelName, null);
});

test("list: another org's binding, or a Mission in another org, never shows", async () => {
  const { deps, asked } = listWorld({
    bound: [
      { row: row("m1", { orgId: "org2" }), budget: null },
      { row: row("m2"), budget: null },
      { row: row("m3"), budget: null },
    ],
    missions: [mission("m1"), mission("m2", { orgId: "org2" }), mission("m3")],
    levels: { m1: "write", m2: "write", m3: "write" },
  });
  const list = await listBoundChannels("viewer", "org1", deps);
  assert.deepEqual(list.map((c) => c.missionId), ["m3"]);
  // Not even asked about.
  assert.deepEqual(asked, ["viewer:m3"]);
});

test("list: each row's state, budget first; a Mission that's gone is left out", async () => {
  const { deps } = listWorld({
    bound: [
      { row: row("m1", { paused: true, idlePaused: true }), budget: null },
      { row: row("m2", { paused: true, idlePaused: true }), budget: { until: LATER, period: "week" } },
      { row: row("m3"), budget: { until: EARLIER, period: "day" } },
      { row: row("gone"), budget: null },
    ],
    missions: [mission("m1"), mission("m2"), mission("m3")],
    levels: { m1: "read", m2: "read", m3: "read", gone: "write" },
  });
  const list = await listBoundChannels("viewer", "org1", deps);
  assert.deepEqual(list.map((c) => [c.missionId, c.state]), [
    ["m1", "idle_paused"],
    ["m2", "budget_paused"],
    ["m3", "on_call"],
  ]);
  assert.equal(list[1].facts.budgetPausedPeriod, "week");
});

test("list: a failing level check hides the row; failing names don't fail the list", async () => {
  const { deps } = listWorld({ bound: [{ row: row("m1"), budget: null }, { row: row("m2"), budget: null }], missions: [mission("m1"), mission("m2")], levels: { m1: "write", m2: "write" } });
  const level = deps.level;
  deps.level = async (userId, m) => (m.id === "m2" ? Promise.reject(new Error("rpc down")) : level(userId, m));
  deps.slackNames = async () => Promise.reject(new Error("Slack down"));
  deps.people = async () => Promise.reject(new Error("auth down"));
  const list = await listBoundChannels("viewer", "org1", deps);
  assert.deepEqual(list.map((c) => c.missionId), ["m1"]);
  assert.equal(list[0].channelName, null);
  assert.equal(list[0].boundBy, null);
});

test("list: nothing bound asks for nothing more", async () => {
  const { deps, asked } = listWorld({ bound: [], missions: [], levels: {} });
  assert.deepEqual(await listBoundChannels("viewer", "org1", deps), []);
  assert.deepEqual(asked, []);
});

// Disconnect.

const binding = (patch: Partial<MissionChannel> = {}): MissionChannel => ({
  missionId: "m1",
  orgId: "org1",
  teamId: "T1",
  channelId: "C1",
  boundBy: "wes",
  listen: "mentions",
  allowBotMessages: false,
  paused: false,
  revision: "rev1",
  ...patch,
});

function disconnectWorld(opts: { binding?: MissionChannel | null; mission?: Workspace | null; level: AccessLevel | null }) {
  const offCall: string[] = [];
  const deps: DisconnectDeps = {
    binding: async () => (opts.binding === undefined ? binding() : opts.binding),
    mission: async () => (opts.mission === undefined ? mission("m1") : opts.mission),
    level: async () => opts.level,
    takeOffCall: async (m, userId) => {
      offCall.push(`${m.id}:${userId}`);
      return true;
    },
  };
  return { deps, offCall };
}

test("disconnect: write on the project takes it off call the one way, as the caller", async () => {
  const { deps, offCall } = disconnectWorld({ level: "write" });
  assert.equal(await disconnectBoundChannel("admin", "org1", "m1", deps), "disconnected");
  assert.deepEqual(offCall, ["m1:admin"]);
});

test("disconnect: read alone is refused, and nothing is taken off", async () => {
  const { deps, offCall } = disconnectWorld({ level: "read" });
  assert.equal(await disconnectBoundChannel("viewer", "org1", "m1", deps), "forbidden");
  assert.deepEqual(offCall, []);
});

test("disconnect: no access, another org's binding, no binding or no Mission reads as not found", async () => {
  const cases: Parameters<typeof disconnectWorld>[0][] = [
    { level: null },
    { level: "write", binding: binding({ orgId: "org2" }) },
    { level: "write", binding: null },
    { level: "write", mission: null },
    { level: "write", mission: mission("m1", { orgId: "org2" }) },
    { level: "write", mission: mission("m1", { kind: "session" }) },
  ];
  for (const c of cases) {
    const { deps, offCall } = disconnectWorld(c);
    assert.equal(await disconnectBoundChannel("viewer", "org1", "m1", deps), "not_found", JSON.stringify(c));
    assert.deepEqual(offCall, []);
  }
});

test("Bound by: a login or a real name, else the account's email, never the \"Someone\" placeholder", () => {
  const NO = "Someone";
  assert.equal(boundByName({ login: "wes", name: "Wes", email: "w@x.dev" }, "u1", NO), "wes");
  assert.equal(boundByName({ login: "", name: "Ana Lima", email: "ana@x.dev" }, "u1", NO), "Ana Lima");
  // An email-only account: personFrom names it the placeholder; the email says who.
  assert.equal(boundByName({ login: "", name: NO, email: "liverun-a@example.com" }, "u1", NO), "liverun-a@example.com");
  assert.equal(boundByName({ login: "", name: "", email: "liverun-a@example.com" }, "u1", NO), "liverun-a@example.com");
  // Nothing to go on: the id, still not "Someone".
  assert.equal(boundByName({ login: "", name: NO, email: null }, "u1", NO), "u1");
  assert.equal(boundByName(undefined, "u1", NO), "u1");
});
