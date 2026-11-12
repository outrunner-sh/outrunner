/**
 * What a Mission and its Ships have spent (docs/mission-spend.md), as policy
 * accounting: which model calls the family made, each once, what they cost
 * and how that's known, by UTC day and ISO week. Pure: the database side is
 * spend.deps.ts.
 *
 * Coverage says how a figure is known:
 *   - `reported`: the provider said what each call cost;
 *   - `estimated`: tokens priced on a versioned cost basis (cost-basis.ts);
 *   - `unavailable`: some cost isn't known. Its dollars are then null, never
 *     0; what is known shows as a lower bound (`knownUsd`).
 */

import { type CallTokens, type ComputeRate, type CostBasis, estimateCall, roundUsd } from "@/lib/missions/cost-basis";
import { hoursUsed, type Interval, type Period } from "@/lib/billing/hours";
import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { SYNTHETIC_MODEL } from "@/lib/runtime/conversation-events";

export type Coverage = "reported" | "estimated" | "unavailable";

const RANK: Record<Coverage, number> = { reported: 0, estimated: 1, unavailable: 2 };

/** The weaker of two coverages: a figure is known only as well as its least
 *  known part. */
export function weakest(...coverages: Coverage[]): Coverage {
  return coverages.reduce<Coverage>((worst, c) => (RANK[c] > RANK[worst] ? c : worst), "reported");
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export type SpendPeriodKind = "day" | "week";

/**
 * The period `at` is in: its calendar day in UTC, or its ISO week, Monday
 * 00:00 UTC to the next. Start inclusive, end exclusive.
 */
export function spendPeriod(kind: SpendPeriodKind, at: Date): Period {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  if (kind === "day") return { start: new Date(day), end: new Date(day + DAY_MS) };
  // getUTCDay: Sunday 0 … Saturday 6; days since Monday.
  const sinceMonday = (at.getUTCDay() + 6) % 7;
  const start = day - sinceMonday * DAY_MS;
  return { start: new Date(start), end: new Date(start + 7 * DAY_MS) };
}

const DAY_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** One model call, as recorded (mission_usage): `usageRef` is unique to the
 *  call across every Mission. */
export type UsageCall = CallTokens & {
  usageRef: string;
  missionId: string;
  workspaceId: string | null;
  source: "session" | "classifier";
  occurredAt: string;
  model: string | null;
  coverage: Coverage;
  usdReported: number | null;
  usdEstimated: number | null;
  costBasis: string | null;
};

/** The Mission whose family a session is in: its own id for a Mission, its
 *  parent's for a Ship, null for any other session. */
export function missionOf(workspace: { id: string; kind?: string | null; parentMissionId?: string | null }): string | null {
  if (workspace.kind === "mission") return workspace.id;
  return workspace.parentMissionId ?? null;
}

const NO_TOKENS: CallTokens = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

/**
 * The model calls in what was read of a family session's log. Each call's
 * reference is the call's own:
 *   - Claude: the reply's message id (`callId`), the same on every record of
 *     the reply, each with its usage so far; a later record of the same call
 *     replaces an earlier one's reading only with more tokens (the database
 *     keeps the larger), so blocks are counted once.
 *   - Codex: its record's uuid (`codex-<session>-<offset>`), which carries
 *     the call's usage alone; its other records carry none and aren't calls.
 * A Claude reply with no usage (an agent from before usage), or usage but no
 * call id (an agent from before `callId`), can't be counted safely: it's
 * recorded as unavailable, under its record's uuid. Claude Code's stand-ins
 * (`<synthetic>`: an API error, a usage limit) made no call.
 */
export function callsFromEvents(
  session: { workspaceId: string; missionId: string },
  events: readonly AgentEvent[],
  extension: CostBasis | null,
  now: Date = new Date(),
): UsageCall[] {
  const calls = new Map<string, UsageCall>();
  for (const event of events) {
    if (event.t !== "message" || event.role !== "assistant") continue;
    if (event.harness || event.compact || event.model === SYNTHETIC_MODEL) continue;
    const codex = event.uuid.startsWith("codex-");
    if (codex && !event.usage) continue;
    const usageRef = codex
      ? `codex:${event.uuid}`
      : event.usage && event.callId
        ? `claude:${event.callId}`
        : `unattributed:${session.workspaceId}:${event.uuid}`;
    const tokens = event.usage ?? NO_TOKENS;
    const countable = Boolean(event.usage && (codex || event.callId));
    const estimate = countable ? estimateCall(event.model, tokens, extension) : null;
    const call: UsageCall = {
      usageRef,
      missionId: session.missionId,
      workspaceId: session.workspaceId,
      source: "session",
      occurredAt: validTime(event.timestamp) ?? now.toISOString(),
      model: event.model ?? null,
      ...tokens,
      coverage: estimate ? "estimated" : "unavailable",
      usdReported: null,
      usdEstimated: estimate?.usd ?? null,
      costBasis: estimate?.basis ?? null,
    };
    const seen = calls.get(usageRef);
    // Within one read too, the reading with the most tokens.
    if (!seen || totalTokens(call) >= totalTokens(seen)) calls.set(usageRef, seen ? { ...call, occurredAt: seen.occurredAt } : call);
  }
  return [...calls.values()];
}

function totalTokens(t: CallTokens): number {
  return t.input_tokens + t.output_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens;
}

function validTime(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** An OpenRouter chat completion's answer, as much of it as says what the
 *  call was and cost (`usage: {include: true}` asks it to say the cost). */
export type OpenRouterAnswer = {
  id?: unknown;
  model?: unknown;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    cost?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown } | null;
  } | null;
};

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/**
 * A classifier call made for a Mission, from OpenRouter's answer: reported
 * when it says the cost; else estimated on the basis from its tokens; else
 * unavailable. Null without a generation id: no reference makes it count once.
 */
export function classifierCall(
  missionId: string,
  answer: OpenRouterAnswer,
  extension: CostBasis | null,
  now: Date = new Date(),
): UsageCall | null {
  if (typeof answer.id !== "string" || !answer.id) return null;
  const cached = count(answer.usage?.prompt_tokens_details?.cached_tokens);
  const tokens: CallTokens = {
    input_tokens: Math.max(0, count(answer.usage?.prompt_tokens) - cached),
    output_tokens: count(answer.usage?.completion_tokens),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
  const model = typeof answer.model === "string" ? answer.model : null;
  const cost = answer.usage?.cost;
  const reported = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? roundUsd(cost) : null;
  const estimate = reported === null && answer.usage ? estimateCall(model, tokens, extension) : null;
  return {
    usageRef: `openrouter:${answer.id}`,
    missionId,
    workspaceId: null,
    source: "classifier",
    occurredAt: now.toISOString(),
    model,
    ...tokens,
    coverage: reported !== null ? "reported" : estimate ? "estimated" : "unavailable",
    usdReported: reported,
    usdEstimated: estimate?.usd ?? null,
    costBasis: estimate?.basis ?? null,
  };
}

// ---------------------------------------------------------------------------
// A period's spend
// ---------------------------------------------------------------------------

/** mission_usage_totals' row. */
export type UsageTotals = {
  reportedUsd: number;
  reportedCalls: number;
  estimatedUsd: number;
  estimatedCalls: number;
  unavailableCalls: number;
  costBases: string[];
  tokens: CallTokens;
};

/** mission_spend_liability's row: what reservations hold now. */
export type Liability = { heldUsd: number; uncertainUsd: number; openReservations: number };

export type MissionSpend = {
  missionId: string;
  period: { kind: SpendPeriodKind; start: string; end: string };
  /** Model calls: the Mission's session, its Ships', classifier calls. */
  models: {
    coverage: Coverage;
    /** Null when unavailable: unknown is never $0. */
    usd: number | null;
    /** What is known: the whole when covered, a lower bound when not. */
    knownUsd: number;
    reportedUsd: number;
    estimatedUsd: number;
    calls: { reported: number; estimated: number; unavailable: number };
    /** The cost bases estimates were made on, by version. */
    costBases: string[];
    tokens: CallTokens;
    /** Family sessions brought up in the period whose log hasn't been read
     *  since (a box that stopped unread): their calls aren't known yet. */
    unreadSessions: number;
  };
  /** The family's boxes, in Small-box hours; dollars only on a configured,
   *  versioned rate, and then an estimate. */
  compute: { hours: number; usd: number | null; rate: string | null; coverage: Coverage | null };
  /** Models, plus compute where a rate turns it into dollars. */
  total: { coverage: Coverage; usd: number | null; knownUsd: number; includesCompute: boolean };
  /** Policy reservations now, whatever the period: held, and uncertain
   *  (lapsed or settled without a cost), never dropped. */
  reservations: Liability;
};

/** Put together a period's spend from what the database holds. */
export function summarizeSpend(input: {
  missionId: string;
  kind: SpendPeriodKind;
  period: Period;
  totals: UsageTotals;
  intervals: readonly Interval[];
  unreadSessions: number;
  liability: Liability;
  rate: ComputeRate | null;
  now: Date;
}): MissionSpend {
  const { totals } = input;
  const modelsCoverage: Coverage =
    totals.unavailableCalls > 0 || input.unreadSessions > 0
      ? "unavailable"
      : totals.estimatedCalls > 0
        ? "estimated"
        : "reported";
  const knownUsd = roundUsd(totals.reportedUsd + totals.estimatedUsd);
  const hours = hoursUsed(input.intervals, input.period, input.now);
  const computeUsd = input.rate ? roundUsd(hours * input.rate.usdPerHour) : null;
  const computeCoverage: Coverage | null = input.rate ? "estimated" : null;
  const totalCoverage = computeCoverage ? weakest(modelsCoverage, computeCoverage) : modelsCoverage;
  const totalKnown = roundUsd(knownUsd + (computeUsd ?? 0));
  return {
    missionId: input.missionId,
    period: { kind: input.kind, start: input.period.start.toISOString(), end: input.period.end.toISOString() },
    models: {
      coverage: modelsCoverage,
      usd: modelsCoverage === "unavailable" ? null : knownUsd,
      knownUsd,
      reportedUsd: roundUsd(totals.reportedUsd),
      estimatedUsd: roundUsd(totals.estimatedUsd),
      calls: { reported: totals.reportedCalls, estimated: totals.estimatedCalls, unavailable: totals.unavailableCalls },
      costBases: [...totals.costBases].sort(),
      tokens: totals.tokens,
      unreadSessions: input.unreadSessions,
    },
    compute: { hours: Math.round(hours * 1e4) / 1e4, usd: computeUsd, rate: input.rate?.version ?? null, coverage: computeCoverage },
    total: {
      coverage: totalCoverage,
      usd: totalCoverage === "unavailable" ? null : totalKnown,
      knownUsd: totalKnown,
      includesCompute: computeUsd !== null,
    },
    reservations: input.liability,
  };
}

/** How long a family session's log may go unread after its box came up
 *  before its calls count as unknown: the tick reads every box that's up
 *  every two minutes, so longer is a box that stopped unread. */
export const UNREAD_GRACE_MS = 10 * 60_000;
