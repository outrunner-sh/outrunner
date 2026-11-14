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

import { createHash } from "node:crypto";

import { type CallTokens, type CostBasis, estimateCall, roundUsd } from "@/lib/missions/cost-basis";
import { type Interval, type Period } from "@/lib/billing/hours";
import { INCLUDED_CENTS_PER_VCPU_HOUR, vcpuHoursUsed } from "@/lib/billing/usage";
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
      usageRef: fitRef(usageRef),
      missionId: session.missionId,
      workspaceId: session.workspaceId,
      source: "session",
      occurredAt: validTime(event.timestamp) ?? now.toISOString(),
      model: fitModel(event.model),
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

/** mission_usage's bounds: a reference of up to 300 characters (a longer one
 *  is its kind and a hash, still one per call), a model name of up to 200. */
const MAX_REF = 300;
const MAX_MODEL = 200;

function fitRef(ref: string): string {
  if (ref.length <= MAX_REF) return ref;
  const kind = ref.slice(0, ref.indexOf(":") + 1).slice(0, 40);
  return `${kind}sha256:${createHash("sha256").update(ref).digest("hex")}`;
}

function fitModel(model: string | null | undefined): string | null {
  return model ? model.slice(0, MAX_MODEL) : null;
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
  const model = fitModel(typeof answer.model === "string" ? answer.model : null);
  const cost = answer.usage?.cost;
  const reported = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? roundUsd(cost) : null;
  const estimate = reported === null && answer.usage ? estimateCall(model, tokens, extension) : null;
  return {
    usageRef: fitRef(`openrouter:${answer.id}`),
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

/** The most UTC days one unread stretch marks: past that, its box was lost
 *  long ago and the first month says enough. */
export const MAX_GAP_DAYS = 31;

/** What every gap entry of one cut-off read starts with: its session, box
 *  and cursor. A later read from that cursor on that box closes them. */
export function gapPrefix(workspaceId: string, box: string | null, cursor: number): string {
  return `gap:${workspaceId}:${box ?? "none"}:${cursor}:`;
}

/**
 * The references a cut-off read's gap can have (gapCalls), to close it by
 * key: one per UTC day from its last read, as many as a gap marks, and no
 * further than today. Never read before (no last read): the gap started
 * when its box stopped, some day in the last MAX_GAP_DAYS.
 */
export function gapRefs(workspaceId: string, lastRead: { box: string | null; cursor: number; at: string | null }, now: Date): string[] {
  const prefix = gapPrefix(workspaceId, lastRead.box, lastRead.cursor);
  const at = validTime(lastRead.at ?? undefined);
  const today = spendPeriod("day", now).start.getTime();
  const first = at ? spendPeriod("day", new Date(at)).start.getTime() : today - (MAX_GAP_DAYS - 1) * DAY_MS;
  const refs: string[] = [];
  for (let day = first; day <= today && refs.length < MAX_GAP_DAYS; day += DAY_MS) {
    refs.push(`${prefix}${new Date(day).toISOString().slice(0, 10)}`);
  }
  return refs;
}

/**
 * A family session whose box went down (or that was paused or archived)
 * mid-turn: what it did after its log was last read may not be read, so the
 * calls in between are unknown until it is. One unavailable entry on each
 * UTC day from the last read to when its box stopped (`until`), so every day
 * the unread stretch touches, and none after it, says it isn't covered.
 * Each once per box, cursor and day; closed (removed) once a read on the
 * same box goes on from that cursor (spend.deps.ts closeSessionGap).
 */
export function gapCalls(
  session: { workspaceId: string; missionId: string },
  lastRead: { box: string | null; cursor: number; at: string | null },
  until: Date,
): UsageCall[] {
  const from = new Date(validTime(lastRead.at ?? undefined) ?? until.toISOString());
  const end = until > from ? until : from;
  const prefix = gapPrefix(session.workspaceId, lastRead.box, lastRead.cursor);
  const calls: UsageCall[] = [];
  for (let day = spendPeriod("day", from).start; day <= end && calls.length < MAX_GAP_DAYS; day = new Date(day.getTime() + DAY_MS)) {
    calls.push({
      usageRef: `${prefix}${day.toISOString().slice(0, 10)}`,
      missionId: session.missionId,
      workspaceId: session.workspaceId,
      source: "session",
      occurredAt: (day > from ? day : from).toISOString(),
      model: null,
      ...NO_TOKENS,
      coverage: "unavailable",
      usdReported: null,
      usdEstimated: null,
      costBasis: null,
    });
  }
  return calls;
}

/** Postgres refused the data itself (classes 22 and 23: a bad value, a
 *  check), which no retry changes. */
export function isDataError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^2[23]/.test(code);
}

/**
 * Write calls in batches. A batch refused for its data is written a call at a
 * time, so one bad call can't hold back the rest; a call refused for its own
 * data is put in as an unavailable stand-in (its cost is unknown, never
 * dropped as $0), and if even that is refused, logged and left out. Left in,
 * it would be refused on every read and hold the session's reads back for
 * good. Anything else (the database unreachable) is thrown: the read is
 * tried again. How many rows were new.
 */
export async function writeCallsIsolating(
  calls: readonly UsageCall[],
  write: (batch: readonly UsageCall[]) => Promise<number>,
  batchSize = 200,
): Promise<number> {
  let made = 0;
  for (let i = 0; i < calls.length; i += batchSize) {
    const batch = calls.slice(i, i + batchSize);
    try {
      made += await write(batch);
      continue;
    } catch (error) {
      if (!isDataError(error)) throw error;
    }
    for (const call of batch) {
      try {
        made += await write([call]);
      } catch (error) {
        if (!isDataError(error)) throw error;
        console.error(`Mission spend: ${call.usageRef} refused (${String((error as { message?: unknown }).message)}); counted as unknown.`);
        const standIn: UsageCall = {
          ...call,
          ...NO_TOKENS,
          usageRef: fitRef(`refused:${call.usageRef}`),
          model: null,
          coverage: "unavailable",
          usdReported: null,
          usdEstimated: null,
          costBasis: null,
        };
        try {
          made += await write([standIn]);
        } catch (standInError) {
          if (!isDataError(standInError)) throw standInError;
          console.error(`Mission spend: ${call.usageRef} can't be recorded at all; left out.`, standInError);
        }
      }
    }
  }
  return made;
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
    /** Entries by coverage. `unavailable` counts entries whose cost is
     *  unknown, which can be more than the calls: each block of a reply from
     *  an agent before `callId`, and each unread stretch (gapCalls), is one. */
    calls: { reported: number; estimated: number; unavailable: number };
    /** The cost bases estimates were made on, by version. */
    costBases: string[];
    tokens: CallTokens;
    /** Family sessions brought up in the period whose log hasn't been read
     *  since (a box that stopped unread): their calls aren't known yet. */
    unreadSessions: number;
  };
  /** The family's boxes: vCPU-hours, and their dollars at the plan's
   *  included rate (lib/billing/usage.ts), the rate an org's usage limit is
   *  measured at. Recorded intervals priced by rule, so never unknown. */
  compute: { vcpuHours: number; usd: number; centsPerVcpuHour: number; coverage: "reported" };
  /** Models plus compute. */
  total: { coverage: Coverage; usd: number | null; knownUsd: number };
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
  const vcpuHours = vcpuHoursUsed(input.intervals, input.period, input.now);
  const computeUsd = roundUsd((vcpuHours * INCLUDED_CENTS_PER_VCPU_HOUR) / 100);
  const totalCoverage = modelsCoverage;
  const totalKnown = roundUsd(knownUsd + computeUsd);
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
    compute: { vcpuHours: Math.round(vcpuHours * 1e4) / 1e4, usd: computeUsd, centsPerVcpuHour: INCLUDED_CENTS_PER_VCPU_HOUR, coverage: "reported" },
    total: {
      coverage: totalCoverage,
      usd: totalCoverage === "unavailable" ? null : totalKnown,
      knownUsd: totalKnown,
    },
    reservations: input.liability,
  };
}

/** How long a family session's log may go unread after its box came up
 *  before its calls count as unknown: the tick reads every box that's up
 *  every two minutes, so longer is a box that stopped unread. */
export const UNREAD_GRACE_MS = 10 * 60_000;
