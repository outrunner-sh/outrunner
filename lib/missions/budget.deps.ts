/**
 * A Mission's budgets, the database side (lib/missions/budget.ts,
 * docs/missions.md "Budgets"): the one check every way in asks
 * (budgetPause), setting a budget (setMissionBudget), and its header's view.
 * Service role throughout: callers check who may first, except
 * setMissionBudget, which checks itself.
 */

import { environmentLevel, projectLevel } from "@/lib/db/org-access";
import { readMissionSpend } from "@/lib/missions/spend.deps";
import type { MissionSpend, SpendPeriodKind } from "@/lib/missions/spend";
import {
  activePause,
  type BudgetDecision,
  type BudgetLimits,
  type BudgetPause,
  countedUsd,
  decideBudget,
  type MissionBudgetView,
  parseLimit,
  periodsToRead,
} from "@/lib/missions/budget";
import { sessionById } from "@/lib/missions/store";
import { allows } from "@/lib/orgs/access";
import type { Workspace } from "@/lib/runtime/types";
import type { Database } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

type MissionBudgetRow = Database["public"]["Tables"]["mission_budgets"]["Row"];

function db() {
  return createSupabaseAdminClient();
}

/** Deployed before its migration: no such table or function. */
function isNotMigrated(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "PGRST202" || code === "42883" || code === "PGRST205" || code === "42P01";
}

const limitsOf = (row: Pick<MissionBudgetRow, "daily_usd" | "weekly_usd">): BudgetLimits => ({
  dailyUsd: row.daily_usd === null ? null : Number(row.daily_usd),
  weeklyUsd: row.weekly_usd === null ? null : Number(row.weekly_usd),
});

/** The Mission's budget row, or null for none. */
export async function readBudget(missionId: string): Promise<MissionBudgetRow | null> {
  const { data, error } = await db().from("mission_budgets").select("*").eq("mission_id", missionId).maybeSingle();
  if (error) {
    if (isNotMigrated(error)) return null;
    throw error;
  }
  return data;
}

/** The periods' spend these limits need, read for `now`. */
async function spendFor(missionId: string, kinds: readonly SpendPeriodKind[], now: Date): Promise<Record<SpendPeriodKind, MissionSpend | null>> {
  const read = await Promise.all(kinds.map((kind) => readMissionSpend(missionId, kind, now, now)));
  return {
    day: read[kinds.indexOf("day")] ?? null,
    week: read[kinds.indexOf("week")] ?? null,
  };
}

async function decide(missionId: string, limits: BudgetLimits, now: Date, kinds = periodsToRead(limits)): Promise<{ decision: BudgetDecision; spend: Record<SpendPeriodKind, MissionSpend | null> }> {
  const spend = await spendFor(missionId, kinds, now);
  return { decision: decideBudget({ limits, day: spend.day, week: spend.week, now }), spend };
}

/**
 * The Mission's budget pause now, or null: the check every way in asks
 * before a Mission turn or a Ship start (Slack, triggers, event delivery,
 * spawn_runner). A pause still running is answered from its row; otherwise,
 * with a limit set, the spend is read and the pause set (or one that ran out
 * lifted) as it calls for, only while the limits are the ones read. `lifted`
 * when this lifted one.
 */
export async function refreshBudget(missionId: string, now: Date = new Date()): Promise<{ pause: BudgetPause | null; lifted: boolean }> {
  const row = await readBudget(missionId);
  if (!row) return { pause: null, lifted: false };
  const running = activePause(row, now);
  if (running) return { pause: running, lifted: false };
  const { decision } = await decide(missionId, limitsOf(row), now);
  return settlePause(missionId, row, decision);
}

/** Write the pause a decision calls for (or lift one that ran out), only
 *  while the row's limits are still the ones decided on. */
async function settlePause(missionId: string, row: MissionBudgetRow, decision: BudgetDecision): Promise<{ pause: BudgetPause | null; lifted: boolean }> {
  const limits = limitsOf(row);
  const stale = row.paused_period !== null || row.paused_until !== null;
  if (decision.pause || stale) {
    const { error } = await db().rpc("settle_mission_budget_pause", {
      target: missionId,
      expect_daily: limits.dailyUsd,
      expect_weekly: limits.weeklyUsd,
      pause_period: decision.pause?.period ?? null,
      pause_until: decision.pause?.until ?? null,
    });
    if (error) throw error;
  }
  return { pause: decision.pause, lifted: stale && !decision.pause };
}

/** budgetPause for the ways in: the pause, or null. */
export async function budgetPause(missionId: string, now: Date = new Date()): Promise<BudgetPause | null> {
  return (await refreshBudget(missionId, now)).pause;
}

/** Deliver what a lifted pause held. Loaded when needed: the outbox's
 *  wiring asks this module for its check. */
async function deliverHeld(missionId: string): Promise<void> {
  const { deliverNow } = await import("@/lib/missions/outbox.deps");
  await deliverNow(missionId);
}

/** Who may change a Mission's budget: its owner, or someone with write on
 *  its project. Who may see it: its owner, or anyone who can read it. */
async function access(userId: string, mission: Workspace): Promise<{ read: boolean; write: boolean }> {
  if (mission.ownerId === userId) return { read: true, write: true };
  const level = await (mission.environmentId ? environmentLevel(userId, mission.environmentId) : projectLevel(userId, mission.projectId)).catch(() => null);
  return { read: allows(level, "read"), write: allows(level, "write") };
}

async function orgOf(mission: Workspace): Promise<string | null> {
  if (mission.orgId) return mission.orgId;
  const { data } = await db().from("projects").select("org_id").eq("id", mission.projectId).maybeSingle();
  return data?.org_id ?? null;
}

export type BudgetError = { error: string; status: 400 | 403 | 404 };

/** A Mission by id, if it's one this user may see. */
async function visibleMission(missionId: string, userId: string): Promise<{ mission: Workspace; write: boolean } | BudgetError> {
  const mission = await sessionById(missionId);
  if (!mission || mission.kind !== "mission") return { error: "Mission not found.", status: 404 };
  const can = await access(userId, mission);
  if (!can.read) return { error: "Mission not found.", status: 404 };
  return { mission, write: can.write };
}

/**
 * Set a Mission's daily and weekly limits (null: no limit; both null: no
 * budget), as `userId`: its owner, or someone with write on its project.
 * The pause is decided from the spend with the new limits and written with
 * them: a limit raised past what's counted lifts it in this call, and what
 * it held is delivered now; one lowered to it pauses at once.
 */
export async function setMissionBudget(
  missionId: string,
  input: { dailyUsd: unknown; weeklyUsd: unknown },
  userId: string,
): Promise<{ view: MissionBudgetView } | BudgetError> {
  const daily = parseLimit(input.dailyUsd, "dailyUsd");
  if ("error" in daily) return { error: daily.error, status: 400 };
  const weekly = parseLimit(input.weeklyUsd, "weeklyUsd");
  if ("error" in weekly) return { error: weekly.error, status: 400 };
  const found = await visibleMission(missionId, userId);
  if ("error" in found) return found;
  if (!found.write) return { error: "Changing a Mission's budget needs write on its project.", status: 403 };
  const orgId = await orgOf(found.mission);
  if (!orgId) return { error: "The Mission's project is gone.", status: 404 };

  const now = new Date();
  const limits: BudgetLimits = { dailyUsd: daily.usd, weeklyUsd: weekly.usd };
  const before = await readBudget(missionId);
  const { decision, spend } = await decide(missionId, limits, now, ["day", "week"]);
  const { error } = await db().rpc("set_mission_budget", {
    target: missionId,
    target_org: orgId,
    daily: limits.dailyUsd,
    weekly: limits.weeklyUsd,
    by_user: userId,
    pause_period: decision.pause?.period ?? null,
    pause_until: decision.pause?.until ?? null,
  });
  if (error) throw error;
  if (activePause(before, now) && !decision.pause) await deliverHeld(missionId);
  return { view: viewOf(limits, decision, spend, true) };
}

function viewOf(limits: BudgetLimits, decision: BudgetDecision, spend: Record<SpendPeriodKind, MissionSpend | null>, canEdit: boolean): MissionBudgetView {
  const of = (s: MissionSpend | null) =>
    s ? { spentUsd: countedUsd(s), partlyUnknown: s.total.coverage === "unavailable" } : null;
  return { limits, day: of(spend.day), week: of(spend.week), paused: decision.pause, canEdit };
}

/** The Mission's budget as its header shows it: limits, this day's and
 *  week's spend with coverage, and the pause, checked afresh (a pause that
 *  ran out is lifted here, and what it held delivered). */
export async function missionBudgetView(missionId: string, userId: string): Promise<{ view: MissionBudgetView } | BudgetError> {
  const found = await visibleMission(missionId, userId);
  if ("error" in found) return found;
  const now = new Date();
  const row = await readBudget(missionId);
  const limits: BudgetLimits = row ? limitsOf(row) : { dailyUsd: null, weeklyUsd: null };
  const { decision, spend } = await decide(missionId, limits, now, ["day", "week"]);
  let paused: BudgetPause | null = null;
  if (row) {
    paused = activePause(row, now);
    if (!paused) {
      const settled = await settlePause(missionId, row, decision);
      paused = settled.pause;
      if (settled.lifted) await deliverHeld(missionId);
    }
  }
  return { view: viewOf(limits, { ...decision, pause: paused }, spend, found.write) };
}
