import assert from "node:assert/strict";
import { test } from "node:test";

import { INCLUDED_CENTS_PER_VCPU_HOUR } from "@/lib/billing/usage";
import {
  BUILTIN_COST_BASIS,
  costBasisExtension,
  estimateCall,
  pricedModelName,
} from "@/lib/missions/cost-basis";
import {
  callsFromEvents,
  classifierCall,
  gapCalls,
  gapPrefix,
  gapRefs,
  isDataError,
  missionOf,
  spendPeriod,
  summarizeSpend,
  type UsageCall,
  type UsageTotals,
  weakest,
  writeCallsIsolating,
} from "@/lib/missions/spend";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";

const MISSION = "m-1";
const SHIP = "s-1";
const session = { workspaceId: SHIP, missionId: MISSION };
const NOW = new Date("2026-11-12T12:00:00Z");

type Message = Extract<AgentEvent, { t: "message" }>;
const reply = (extra: Partial<Message>): AgentEvent => ({
  t: "message",
  uuid: crypto.randomUUID(),
  parentUuid: null,
  role: "assistant",
  timestamp: "2026-11-12T10:00:00.000Z",
  content: [{ type: "text", text: "ok" }],
  model: "claude-sonnet-5-5",
  ...extra,
});
const tokens = (input: number, output: number, write = 0, read = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
});

// ---------------------------------------------------------------------------
// Periods and their rollover
// ---------------------------------------------------------------------------

test("a day is its UTC calendar day, start inclusive, end exclusive", () => {
  assert.deepEqual(spendPeriod("day", new Date("2026-11-12T23:59:59.999Z")), {
    start: new Date("2026-11-12T00:00:00Z"),
    end: new Date("2026-11-13T00:00:00Z"),
  });
  // The next instant is the next day.
  assert.equal(spendPeriod("day", new Date("2026-11-13T00:00:00Z")).start.toISOString(), "2026-11-13T00:00:00.000Z");
  // UTC, whatever the local time zone: 23:30 in UTC-5 is the next UTC day.
  assert.equal(spendPeriod("day", new Date("2026-11-12T23:30:00-05:00")).start.toISOString(), "2026-11-13T00:00:00.000Z");
});

test("a week is the ISO week, from Monday 00:00 UTC", () => {
  // Thursday 12 November 2026.
  assert.deepEqual(spendPeriod("week", NOW), { start: new Date("2026-11-09T00:00:00Z"), end: new Date("2026-11-16T00:00:00Z") });
  // Sunday's last instant is still that week; Monday 00:00 starts the next.
  assert.equal(spendPeriod("week", new Date("2026-11-15T23:59:59.999Z")).start.toISOString(), "2026-11-09T00:00:00.000Z");
  assert.equal(spendPeriod("week", new Date("2026-11-16T00:00:00Z")).start.toISOString(), "2026-11-16T00:00:00.000Z");
  // A Monday is its own week's start.
  assert.equal(spendPeriod("week", new Date("2026-11-09T00:00:00Z")).start.toISOString(), "2026-11-09T00:00:00.000Z");
  // Across a year: Thursday 31 December 2026's week runs from Monday 28th.
  assert.deepEqual(spendPeriod("week", new Date("2026-12-31T08:00:00Z")), {
    start: new Date("2026-12-28T00:00:00Z"),
    end: new Date("2027-01-04T00:00:00Z"),
  });
});

// ---------------------------------------------------------------------------
// The family
// ---------------------------------------------------------------------------

test("a Mission's session and its Ships are its family; other sessions are no one's", () => {
  assert.equal(missionOf({ id: MISSION, kind: "mission", parentMissionId: null }), MISSION);
  assert.equal(missionOf({ id: SHIP, kind: "session", parentMissionId: MISSION }), MISSION);
  assert.equal(missionOf({ id: "x", kind: "session", parentMissionId: null }), null);
});

// ---------------------------------------------------------------------------
// Double counting
// ---------------------------------------------------------------------------

test("a reply logged as several records, each with its usage so far, is one call with its last usage", () => {
  const events = [
    reply({ callId: "msg_1", usage: tokens(10, 1, 100, 1000), content: [{ type: "thinking" }] }),
    reply({ callId: "msg_1", usage: tokens(10, 30, 100, 1000), timestamp: "2026-11-12T10:00:05.000Z" }),
    reply({ callId: "msg_1", usage: tokens(10, 80, 100, 1000), stopReason: "tool_use", timestamp: "2026-11-12T10:00:09.000Z" }),
    { ...reply({}), role: "user", model: undefined } as AgentEvent,
    reply({ callId: "msg_2", usage: tokens(5, 20, 0, 1200), timestamp: "2026-11-12T10:01:00.000Z" }),
  ];
  const calls = callsFromEvents(session, events, null, NOW);
  assert.deepEqual(
    calls.map((c) => [c.usageRef, c.output_tokens, c.occurredAt]),
    [
      ["claude:msg_1", 80, "2026-11-12T10:00:00.000Z"],
      ["claude:msg_2", 20, "2026-11-12T10:01:00.000Z"],
    ],
  );
  // Sonnet 5.5: $2 in, $10 out, $2.5 cache writes, $0.10 cache reads per MTok.
  assert.equal(calls[0].usdEstimated, (10 * 2 + 80 * 10 + 100 * 2.5 + 1000 * 0.1) / 1e6);
  assert.equal(calls[0].coverage, "estimated");
  assert.equal(calls[0].costBasis, BUILTIN_COST_BASIS.version);
});

test("the same log read again (a re-read, a restored box) gives the same references, so nothing counts twice", () => {
  const events = [reply({ callId: "msg_1", usage: tokens(1, 2) }), reply({ callId: "msg_2", usage: tokens(3, 4) })];
  const first = callsFromEvents(session, events, null, NOW);
  const again = callsFromEvents(session, events, null, NOW);
  assert.deepEqual(again, first);
  // As the database keeps them (record_mission_usage): one row per reference,
  // the reading with the most tokens.
  const kept = new Map<string, UsageCall>();
  for (const call of [...first, ...again, ...callsFromEvents(session, events.slice(0, 1), null, NOW)]) {
    const seen = kept.get(call.usageRef);
    if (!seen || call.output_tokens > seen.output_tokens) kept.set(call.usageRef, call);
  }
  assert.equal(kept.size, 2);
  // A tail read alone (the cursor mid-reply) names the same call.
  const tail = callsFromEvents(session, [reply({ callId: "msg_2", usage: tokens(3, 9) })], null, NOW);
  assert.equal(tail[0].usageRef, "claude:msg_2");
});

test("a call's reference doesn't depend on the session that read it: a forked transcript can't count it again", () => {
  const event = reply({ callId: "msg_1", usage: tokens(1, 2) });
  const a = callsFromEvents(session, [event], null, NOW)[0];
  const b = callsFromEvents({ workspaceId: "other", missionId: "m-2" }, [event], null, NOW)[0];
  assert.equal(a.usageRef, b.usageRef);
});

test("Codex: the record with the call's usage is the call; records without usage aren't", () => {
  const calls = callsFromEvents(
    session,
    [
      reply({ uuid: "codex-s-10", model: "gpt-5.5-codex" }),
      reply({ uuid: "codex-s-20", model: "gpt-5.5-codex", usage: tokens(100, 50) }),
    ],
    null,
    NOW,
  );
  assert.deepEqual(
    calls.map((c) => [c.usageRef, c.coverage]),
    [["codex:codex-s-20", "unavailable"]],
  );
});

test("Claude Code's own stand-ins, harness changes and compactions made no call", () => {
  const calls = callsFromEvents(
    session,
    [
      reply({ model: "<synthetic>", usage: tokens(0, 0) }),
      reply({ harness: { from: "claude", to: "codex" }, model: undefined }),
      reply({ compact: { trigger: "auto" }, model: undefined }),
    ],
    null,
    NOW,
  );
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Unavailable coverage
// ---------------------------------------------------------------------------

test("a call that can't be counted safely, or priced, is unavailable: never $0", () => {
  const calls = callsFromEvents(
    session,
    [
      // An agent from before usage: a reply, no tokens.
      reply({ uuid: "old" }),
      // An agent from before callId: tokens, but no call to count them once by.
      reply({ uuid: "no-call", usage: tokens(1, 2) }),
      // A model no cost basis lists.
      reply({ callId: "msg_x", usage: tokens(1, 2), model: "z-ai/glm-5.3" }),
    ],
    null,
    NOW,
  );
  assert.deepEqual(
    calls.map((c) => [c.usageRef, c.coverage, c.usdEstimated, c.usdReported]),
    [
      [`unattributed:${SHIP}:old`, "unavailable", null, null],
      [`unattributed:${SHIP}:no-call`, "unavailable", null, null],
      ["claude:msg_x", "unavailable", null, null],
    ],
  );
});

const noTotals: UsageTotals = {
  reportedUsd: 0,
  reportedCalls: 0,
  estimatedUsd: 0,
  estimatedCalls: 0,
  unavailableCalls: 0,
  costBases: [],
  tokens: tokens(0, 0),
};
const summary = (over: Partial<Parameters<typeof summarizeSpend>[0]> = {}) =>
  summarizeSpend({
    missionId: MISSION,
    kind: "day",
    period: spendPeriod("day", NOW),
    totals: noTotals,
    intervals: [],
    unreadSessions: 0,
    liability: { heldUsd: 0, uncertainUsd: 0, openReservations: 0 },
    now: NOW,
    ...over,
  });

test("a period with an unknown call shows no dollars, and what's known as a lower bound", () => {
  const spend = summary({ totals: { ...noTotals, reportedUsd: 0.5, reportedCalls: 1, estimatedUsd: 1.25, estimatedCalls: 3, unavailableCalls: 1, costBases: ["b"] } });
  assert.equal(spend.models.coverage, "unavailable");
  assert.equal(spend.models.usd, null);
  assert.equal(spend.models.knownUsd, 1.75);
  assert.equal(spend.total.usd, null);
  assert.equal(spend.total.coverage, "unavailable");
});

test("a family session sent something but not read since is unknown, not $0", () => {
  const spend = summary({ unreadSessions: 1 });
  assert.equal(spend.models.coverage, "unavailable");
  assert.equal(spend.models.usd, null);
  assert.equal(spend.models.unreadSessions, 1);
});

test("coverage is the least known part: reported, then estimated", () => {
  assert.equal(summary({ totals: { ...noTotals, reportedUsd: 0.2, reportedCalls: 2 } }).models.coverage, "reported");
  const mixed = summary({ totals: { ...noTotals, reportedUsd: 0.2, reportedCalls: 2, estimatedUsd: 0.1, estimatedCalls: 1, costBases: ["z", "a"] } });
  assert.equal(mixed.models.coverage, "estimated");
  assert.ok(Math.abs(mixed.models.usd! - 0.3) < 1e-9);
  assert.deepEqual(mixed.models.costBases, ["a", "z"]);
  // Nothing spent, everything read: a known zero.
  assert.deepEqual([summary().models.coverage, summary().models.usd], ["reported", 0]);
  assert.equal(weakest("reported", "estimated", "reported"), "estimated");
  assert.equal(weakest(), "reported");
});

test("compute is priced at the plan's included rate, the one usage limits are measured at", () => {
  const intervals = [
    // A Small box (2 vCPU) from 09:00 to 11:00, and a Medium (4) from 23:00 the day before to 01:00.
    { sandboxId: "a", cpu: 2, startedAt: new Date("2026-11-12T09:00:00Z"), lastSeenAt: new Date("2026-11-12T11:00:00Z"), endedAt: new Date("2026-11-12T11:00:00Z") },
    { sandboxId: "b", cpu: 4, startedAt: new Date("2026-11-11T23:00:00Z"), lastSeenAt: new Date("2026-11-12T01:00:00Z"), endedAt: new Date("2026-11-12T01:00:00Z") },
  ];
  const totals = { ...noTotals, reportedUsd: 1, reportedCalls: 1 };
  const spend = summary({ intervals, totals });
  // 2 vCPU for 2 hours, plus the Medium's one hour within the day at 4 vCPU.
  assert.equal(spend.compute.vcpuHours, 8);
  // 12¢ a vCPU-hour (lib/billing/usage.ts), never the overage rate.
  assert.equal(spend.compute.centsPerVcpuHour, INCLUDED_CENTS_PER_VCPU_HOUR);
  assert.deepEqual([spend.compute.usd, spend.compute.coverage], [0.96, "reported"]);
  assert.deepEqual([spend.total.usd, spend.total.coverage, spend.total.knownUsd], [1.96, "reported", 1.96]);
  // The models' own figure stays the models'.
  assert.deepEqual([spend.models.usd, spend.models.coverage], [1, "reported"]);
  // Compute's dollars are known even when a model call isn't: they count in the lower bound.
  const unknown = summary({ intervals, totals: { ...totals, unavailableCalls: 1 } });
  assert.deepEqual([unknown.total.usd, unknown.total.coverage, unknown.total.knownUsd], [null, "unavailable", 1.96]);
});

test("compute rolls over with the period: the week holds what the day splits", () => {
  const intervals = [
    { sandboxId: "a", cpu: 2, startedAt: new Date("2026-11-15T23:00:00Z"), lastSeenAt: new Date("2026-11-16T01:00:00Z"), endedAt: new Date("2026-11-16T01:00:00Z") },
  ];
  const now = new Date("2026-11-17T00:00:00Z");
  const sunday = summary({ intervals, now, period: spendPeriod("day", new Date("2026-11-15T12:00:00Z")) });
  const monday = summary({ intervals, now, period: spendPeriod("day", new Date("2026-11-16T12:00:00Z")) });
  const lastWeek = summary({ intervals, now, kind: "week", period: spendPeriod("week", new Date("2026-11-15T12:00:00Z")) });
  const thisWeek = summary({ intervals, now, kind: "week", period: spendPeriod("week", new Date("2026-11-16T12:00:00Z")) });
  assert.deepEqual([sunday.compute.vcpuHours, monday.compute.vcpuHours, lastWeek.compute.vcpuHours, thisWeek.compute.vcpuHours], [2, 2, 2, 2]);
});

// ---------------------------------------------------------------------------
// Classifier calls
// ---------------------------------------------------------------------------

test("a classifier call is reported where OpenRouter says its cost, under its generation id", () => {
  const call = classifierCall(
    MISSION,
    { id: "gen-1", model: "anthropic/claude-sonnet-5.5", usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.00042, prompt_tokens_details: { cached_tokens: 20 } } },
    null,
    NOW,
  )!;
  assert.deepEqual(
    [call.usageRef, call.source, call.workspaceId, call.coverage, call.usdReported, call.usdEstimated, call.input_tokens, call.cache_read_input_tokens],
    ["openrouter:gen-1", "classifier", null, "reported", 0.00042, null, 100, 20],
  );
});

test("a classifier call without its cost is estimated, or unavailable; without an id, not counted", () => {
  const estimated = classifierCall(MISSION, { id: "gen-2", model: "anthropic/claude-sonnet-5.5", usage: { prompt_tokens: 1000, completion_tokens: 100 } }, null, NOW)!;
  assert.deepEqual([estimated.coverage, estimated.usdEstimated], ["estimated", (1000 * 2 + 100 * 10) / 1e6]);
  const unknownModel = classifierCall(MISSION, { id: "gen-3", model: "someone/else", usage: { prompt_tokens: 1, completion_tokens: 1 } }, null, NOW)!;
  assert.deepEqual([unknownModel.coverage, unknownModel.usdEstimated, unknownModel.usdReported], ["unavailable", null, null]);
  const noUsage = classifierCall(MISSION, { id: "gen-4", model: "anthropic/claude-sonnet-5.5" }, null, NOW)!;
  assert.equal(noUsage.coverage, "unavailable");
  assert.equal(classifierCall(MISSION, { model: "x", usage: { cost: 1 } }, null, NOW), null);
});

// ---------------------------------------------------------------------------
// The cost basis
// ---------------------------------------------------------------------------

test("models are priced under one name, however the log spells them", () => {
  assert.equal(pricedModelName("anthropic/claude-sonnet-5.5"), "claude-sonnet-5-5");
  assert.equal(pricedModelName("claude-opus-4-6[1m]"), "claude-opus-4-6");
  assert.equal(pricedModelName("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
  assert.equal(pricedModelName("Z-AI/GLM-5.3"), "z-ai/glm-5.3");
});

test("Haiku 5.5's long prompts are priced at its higher rate", () => {
  const short = estimateCall("claude-haiku-5-5", tokens(1000, 1000), null)!;
  const long = estimateCall("claude-haiku-5-5", tokens(1000, 1000, 0, 100_000), null)!;
  assert.equal(short.usd, (1000 * 0.1 + 1000 * 0.5) / 1e6);
  assert.equal(long.usd, (1000 * 0.5 + 1000 * 2.5 + 100_000 * 0.05) / 1e6);
});

test("the deployment's cost basis prices what the built-in one doesn't, under its own version", () => {
  const extension = costBasisExtension(JSON.stringify({ version: "or-2026-11", models: { "z-ai/glm-5.3": { input: 0.5, output: 2 } } }));
  assert.ok(extension);
  assert.deepEqual(estimateCall("z-ai/glm-5.3", tokens(1_000_000, 1_000_000), extension), { usd: 2.5, basis: "or-2026-11" });
  // Built-in ones keep the built-in basis.
  assert.equal(estimateCall("claude-opus-5-5", tokens(1, 1), extension)?.basis, BUILTIN_COST_BASIS.version);
  // Set wrong: nothing is priced on it.
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(costBasisExtension("{not json"), null);
    assert.equal(costBasisExtension(JSON.stringify({ models: {} })), null);
  } finally {
    console.error = quiet;
  }
  assert.equal(costBasisExtension(""), null);
});

// ---------------------------------------------------------------------------
// Writing: a bad call can't hold reads back; an unread stretch is unknown
// ---------------------------------------------------------------------------

const refusal = (code: string) => Object.assign(new Error(`refused ${code}`), { code });
const quietly = async <T>(work: () => Promise<T>): Promise<T> => {
  const quiet = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = quiet;
  }
};

test("a call the database refuses for its data is counted as unknown, and the rest are written", async () => {
  const calls = callsFromEvents(session, ["a", "bad", "c"].map((id) => reply({ callId: id, usage: tokens(1, 2) })), null, NOW);
  const written: string[] = [];
  const write = async (batch: readonly UsageCall[]) => {
    if (batch.some((c) => c.usageRef === "claude:bad")) throw refusal("23514");
    written.push(...batch.map((c) => `${c.usageRef}:${c.coverage}:${c.usdEstimated}`));
    return batch.length;
  };
  assert.equal(await quietly(() => writeCallsIsolating(calls, write, 10)), 3);
  assert.deepEqual(written, [
    `claude:a:estimated:${calls[0].usdEstimated}`,
    "refused:claude:bad:unavailable:null",
    `claude:c:estimated:${calls[2].usdEstimated}`,
  ]);
});

test("a call whose stand-in is refused too is left out, never holding the read back", async () => {
  const calls = callsFromEvents(session, [reply({ callId: "x", usage: tokens(1, 2) })], null, NOW);
  assert.equal(await quietly(() => writeCallsIsolating(calls, async () => Promise.reject(refusal("22023")))), 0);
});

test("the database unreachable is thrown, so the read is tried again", async () => {
  const calls = callsFromEvents(session, [reply({ callId: "x", usage: tokens(1, 2) })], null, NOW);
  await assert.rejects(writeCallsIsolating(calls, async () => Promise.reject(new Error("fetch failed"))), /fetch failed/);
  await assert.rejects(writeCallsIsolating(calls, async () => Promise.reject(refusal("57P01"))), /57P01/);
  assert.equal(isDataError(refusal("23505")), true);
  assert.equal(isDataError(refusal("PGRST202")), false);
});

test("what doesn't fit the table is fitted: a long call id hashed (still one per call), a long model cut", () => {
  const long = "msg_" + "x".repeat(400);
  const [call] = callsFromEvents(session, [reply({ callId: long, usage: tokens(1, 1), model: "m".repeat(300) })], null, NOW);
  assert.match(call.usageRef, /^claude:sha256:[0-9a-f]{64}$/);
  assert.equal(callsFromEvents(session, [reply({ callId: long, usage: tokens(1, 1) })], null, NOW)[0].usageRef, call.usageRef);
  assert.equal(call.model?.length, 200);
});

test("a turn cut off unread is unknown on each UTC day from the last read to when its box stopped, and no later", () => {
  const sameDay = gapCalls(session, { box: "sb-1", cursor: 42, at: "2026-11-12T09:00:00Z" }, new Date("2026-11-12T09:30:00Z"));
  assert.deepEqual(
    sameDay.map((c) => [c.usageRef, c.occurredAt, c.coverage, c.usdEstimated]),
    [[`gap:${SHIP}:sb-1:42:2026-11-12`, "2026-11-12T09:00:00.000Z", "unavailable", null]],
  );
  // Read on Tuesday night, stopped on Friday: Tuesday to Friday, a day in between included.
  const across = gapCalls(session, { box: "sb-1", cursor: 7, at: "2026-11-10T23:50:00Z" }, new Date("2026-11-13T02:00:00Z"));
  assert.deepEqual(across.map((c) => c.occurredAt), [
    "2026-11-10T23:50:00.000Z",
    "2026-11-11T00:00:00.000Z",
    "2026-11-12T00:00:00.000Z",
    "2026-11-13T00:00:00.000Z",
  ]);
  // Never read: from when it stopped. A stop clock behind the read: the read's day alone.
  assert.deepEqual(gapCalls(session, { box: null, cursor: 0, at: null }, NOW).map((c) => c.usageRef), [`gap:${SHIP}:none:0:2026-11-12`]);
  assert.equal(gapCalls(session, { box: "b", cursor: 1, at: "2026-11-12T10:00:00Z" }, new Date("2026-11-12T09:00:00Z")).length, 1);
  // A box lost for months marks the first month, no more.
  assert.equal(gapCalls(session, { box: "b", cursor: 1, at: "2026-01-01T00:00:00Z" }, NOW).length, 31);
  // It makes the day unavailable.
  const day = summary({ totals: { ...noTotals, reportedUsd: 1, reportedCalls: 1, unavailableCalls: sameDay.length } });
  assert.deepEqual([day.models.coverage, day.models.usd, day.models.knownUsd], ["unavailable", null, 1]);
});

test("a gap's entries are found again by key from its session, box, cursor and last read", () => {
  assert.equal(gapPrefix(SHIP, "sb-1", 42), `gap:${SHIP}:sb-1:42:`);
  const cases: { at: string | null; until: string; now: string }[] = [
    { at: "2026-11-12T09:00:00Z", until: "2026-11-12T09:30:00Z", now: "2026-11-12T10:00:00Z" },
    // Days apart, and read again days later still.
    { at: "2026-11-10T23:50:00Z", until: "2026-11-13T02:00:00Z", now: "2026-11-15T08:00:00Z" },
    // Never read before.
    { at: null, until: "2026-11-01T02:00:00Z", now: "2026-11-12T08:00:00Z" },
    // A box lost for months.
    { at: "2026-01-01T00:00:00Z", until: "2026-11-12T00:00:00Z", now: "2026-11-12T08:00:00Z" },
  ];
  for (const { at, until, now } of cases) {
    const lastRead = { box: "sb-1", cursor: 42, at };
    const made = gapCalls(session, lastRead, new Date(until)).map((c) => c.usageRef);
    const keys = new Set(gapRefs(SHIP, lastRead, new Date(now)));
    assert.ok(keys.size <= 31);
    for (const ref of made) assert.ok(keys.has(ref), `${ref} found again (${at} → ${until}, read ${now})`);
  }
  // Another box or cursor: none of them.
  const other = new Set(gapRefs(SHIP, { box: "sb-1", cursor: 43, at: "2026-11-12T09:00:00Z" }, NOW));
  assert.ok(gapCalls(session, { box: "sb-1", cursor: 42, at: "2026-11-12T09:00:00Z" }, NOW).every((c) => !other.has(c.usageRef)));
});
