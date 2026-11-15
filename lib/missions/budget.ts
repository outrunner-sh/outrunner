/**
 * A Mission's daily and weekly dollar budgets (docs/missions.md, "Budgets"):
 * the decision, with no database. The database side is budget.deps.ts.
 *
 * Spend is mission spend accounting's (lib/missions/spend.ts): the family's
 * models plus compute at the plan's included rate, in spendPeriod's UTC day
 * and ISO week. What counts against a limit is what's known
 * (`total.knownUsd`) plus what reservations hold or left uncertain: an
 * unknown cost never counts as $0, but never stops a Mission on a guess
 * either. The budget is reached only when that already reaches the limit.
 *
 * Reached, the whole Mission is budget-paused until its period ends
 * (`paused_until`), or until its limit is raised past what's counted.
 */

import { roundUsd } from "@/lib/missions/cost-basis";
import { type MissionSpend, type SpendPeriodKind, spendPeriod } from "@/lib/missions/spend";

export type BudgetLimits = { dailyUsd: number | null; weeklyUsd: number | null };

/** A budget pause: which period was reached, and when it ends. */
export type BudgetPause = { period: SpendPeriodKind; until: string };

/** The template default for a Mission hired for on-call. */
export const DEFAULT_BUDGET: BudgetLimits = { dailyUsd: 100, weeklyUsd: 1000 };

/** numeric(12, 2)'s ceiling, well short of it. */
export const MAX_BUDGET_USD = 1_000_000;

/** One period's standing against its limit. */
export type PeriodStanding = {
  kind: SpendPeriodKind;
  limitUsd: number;
  /** Known spend plus held and uncertain reservations. */
  countedUsd: number;
  knownUsd: number;
  reservedUsd: number;
  /** Some of the period's spend isn't known (coverage `unavailable`). */
  partlyUnknown: boolean;
  reached: boolean;
  /** When this period ends: a pause for it lasts until then. */
  endsAt: string;
};

export type BudgetDecision = {
  day: PeriodStanding | null;
  week: PeriodStanding | null;
  /** The pause this calls for, or null. */
  pause: BudgetPause | null;
};

/** What counts against a limit: known spend, plus what reservations hold and
 *  what they left uncertain. */
export function countedUsd(spend: Pick<MissionSpend, "total" | "reservations">): number {
  return roundUsd(spend.total.knownUsd + spend.reservations.heldUsd + spend.reservations.uncertainUsd);
}

function standing(kind: SpendPeriodKind, limitUsd: number, spend: MissionSpend, now: Date): PeriodStanding {
  const counted = countedUsd(spend);
  return {
    kind,
    limitUsd,
    countedUsd: counted,
    knownUsd: spend.total.knownUsd,
    reservedUsd: roundUsd(spend.reservations.heldUsd + spend.reservations.uncertainUsd),
    partlyUnknown: spend.total.coverage === "unavailable",
    reached: counted >= limitUsd,
    endsAt: spendPeriod(kind, now).end.toISOString(),
  };
}

/**
 * Whether the budget is reached, from the periods' spend (each read with
 * spendPeriod for `now`; only a period with a limit needs one). Both
 * reached: the week's pause, the longer.
 */
export function decideBudget(input: { limits: BudgetLimits; day: MissionSpend | null; week: MissionSpend | null; now: Date }): BudgetDecision {
  const { limits, now } = input;
  const day = limits.dailyUsd !== null && input.day ? standing("day", limits.dailyUsd, input.day, now) : null;
  const week = limits.weeklyUsd !== null && input.week ? standing("week", limits.weeklyUsd, input.week, now) : null;
  const reached = week?.reached ? week : day?.reached ? day : null;
  return { day, week, pause: reached ? { period: reached.kind, until: reached.endsAt } : null };
}

/** The pause a budget row holds now: none once its `paused_until` has
 *  passed (the period rolled over). */
export function activePause(row: { paused_period: SpendPeriodKind | null; paused_until: string | null } | null, now: Date): BudgetPause | null {
  if (!row?.paused_period || !row.paused_until) return null;
  return Date.parse(row.paused_until) > now.getTime() ? { period: row.paused_period, until: row.paused_until } : null;
}

/** Which periods need their spend read for these limits. */
export function periodsToRead(limits: BudgetLimits): SpendPeriodKind[] {
  return [...(limits.dailyUsd !== null ? (["day"] as const) : []), ...(limits.weeklyUsd !== null ? (["week"] as const) : [])];
}

/** A limit as the API takes it: a positive number of dollars, to the cent,
 *  or null for none. */
export function parseLimit(value: unknown, name: string): { usd: number | null } | { error: string } {
  if (value === null) return { usd: null };
  if (typeof value !== "number" || !Number.isFinite(value)) return { error: `${name} is a number of dollars, or null for no limit.` };
  const usd = Math.round(value * 100) / 100;
  if (usd <= 0) return { error: `${name} must be more than $0 (null for no limit).` };
  if (usd > MAX_BUDGET_USD) return { error: `${name} can be at most $${MAX_BUDGET_USD.toLocaleString("en-US")}.` };
  return { usd };
}

/** "today" or "this week", as every budget message says it. */
export const periodWord = (period: SpendPeriodKind): string => (period === "day" ? "today" : "this week");

/** Why spawn_runner didn't start a Ship: said to the Mission. No dollars. */
export function budgetStartRefusal(period: SpendPeriodKind): string {
  return `the Mission's budget for ${periodWord(period)} is reached, so it starts no Ship until the ${period} rolls over or someone raises its budget`;
}

/** A trigger's run while the Mission is budget-paused: recorded, skipped. */
export function budgetRunSkipped(period: SpendPeriodKind): string {
  return `The Mission's budget for ${periodWord(period)} is reached: nothing was sent to it. It goes on when the ${period} rolls over or someone raises its budget.`;
}

/** A Mission's budget as its header shows it (GET /api/missions/[id]/budget). */
export type MissionBudgetView = {
  limits: BudgetLimits;
  day: { spentUsd: number; partlyUnknown: boolean } | null;
  week: { spentUsd: number; partlyUnknown: boolean } | null;
  paused: BudgetPause | null;
  canEdit: boolean;
};
