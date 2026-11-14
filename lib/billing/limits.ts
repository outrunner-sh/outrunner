/**
 * The plan's limits on cloud sessions, applied where a box starts
 * (lib/billing/plans.ts): what the account's cloud usage leaves it
 * (lib/billing/standing.ts, lib/billing/usage.ts), and boxes running at
 * once. A box is what a plan buys and what the limits protect — each
 * session has its own box (a project's sessions from before share one), so
 * `concurrentCloudSessions` counts boxes, as plans.ts defines it and the
 * meter meters it. The Billing page sells the same limit as "sessions".
 *
 * Two-sided on purpose: usage is checked here against the meter
 * (compute_intervals), and the box count is enforced in the database,
 * inside claim_runtime_computer, so two requests that start boxes at the
 * same moment cannot both pass it. A session whose box is already running
 * starts no box, so the count doesn't refuse it.
 *
 * No box starts once the trial's credit or a fixed plan's included usage is
 * spent, at the limit the org's admins set, or while an overage payment is
 * failing; the refusal says which, and where to go. A box already running
 * is not paused for the box cap or an unpaid overage, but is for the first
 * two: the reconciler's usage sweep pauses it (lib/billing/usage-sweep.ts).
 * Otherwise a box is paused when its last session is archived or ended
 * (lib/billing/release-box.ts), and the reconciler pauses idle ones itself,
 * after 15 minutes.
 *
 * The deployment's named operators can be exempted with
 * RUNTIME_PLAN_LIMIT_EXEMPT_GITHUB_LOGIN. That is separate from
 * RUNTIME_OWNER_GITHUB_LOGIN, which controls sign-in; an unset exemption list
 * exempts nobody, so open sign-up does not disable plan limits.
 */

import { parseAllowlist } from "@/lib/auth/allowlist";
import type { Owner } from "@/lib/auth/owner";
import type { Plan } from "@/lib/billing/plans";
import { blocksStarts, formatUsd, type UsageStanding } from "@/lib/billing/usage";
import { optionalEnv } from "@/lib/env";
import { type ComputerScope, inScope } from "@/lib/runtime/computer-scope";
import type { ProviderName, RuntimeComputer } from "@/lib/runtime/types";

/** How a refused start points at a way past the limit. */
export const UPGRADE_HREF = "/upgrade" as const;

/** Where an unpaid overage is paid: the org's billing. */
export const BILLING_HREF = "/settings/org/billing" as const;

/** Where the refusal sends the user: a plan (the trial's credit spent), the
 *  org's usage controls (an admin's limit), or its billing (unpaid). */
export type CloudLimitDenial = {
  error: string;
  settingsHref: typeof UPGRADE_HREF | "/settings/org/usage" | typeof BILLING_HREF;
};

/** A gate's answer: the refusal, or the box cap the claim is to enforce. */
export type CloudBoxStartGate = { denial: CloudLimitDenial } | { cap: number | null };

/** A provisioning claim gone this long without a word: its provision died,
 *  and it no longer holds one of the plan's slots. */
export const STALE_PROVISION_MS = 10 * 60_000;

/** A refused start thrown across a boundary that answers with JSON (session
 *  attach's bring-back), to be answered where it is caught. */
export class CloudLimitError extends Error {
  readonly denial: CloudLimitDenial;

  constructor(denial: CloudLimitDenial) {
    super(denial.error);
    this.denial = denial;
    this.name = "CloudLimitError";
  }
}

/** claim_runtime_computer's refusal (errcode P4BX1): the plan's box cap. */
export function isPlanLimitError(error: unknown): { message: string } | null {
  if (error && typeof error === "object" && "code" in error && error.code === "P4BX1") {
    return { message: String((error as { message?: unknown }).message ?? "") };
  }
  return null;
}

/** Why usage stops the account, in a sentence; null while it doesn't. One
 *  wording for the start gate's refusal and the sweep's pause notice. */
export function usageReason(standing: UsageStanding, plan: Plan): string | null {
  switch (standing.state) {
    case "included_spent":
      return plan.id === "free"
        ? `The free trial's ${formatUsd(standing.includedCapCents)} of cloud usage is used up.`
        : `The ${plan.label} plan's ${formatUsd(standing.includedCapCents)} of cloud usage is used up for this period.`;
    case "at_limit":
      return `The org's usage limit of ${formatUsd(standing.limitCents ?? 0)} is reached for this period.`;
    case "unpaid":
      return "An overage payment failed.";
    case "overage":
    case "within":
      return null;
  }
}

/** The refusal for a box starting where usage stops it: why, and what to do. */
export function usageDenial(standing: UsageStanding, plan: Plan): CloudLimitDenial | null {
  const reason = usageReason(standing, plan);
  if (!reason || !blocksStarts(standing.state)) return null;
  switch (standing.state) {
    case "at_limit":
      return { error: `${reason} An admin can raise it in Settings → Org → Usage.`, settingsHref: "/settings/org/usage" };
    case "unpaid":
      return { error: `${reason} Pay it in Settings → Org → Billing to start new sessions.`, settingsHref: BILLING_HREF };
    default:
      return {
        error: plan.id === "free" ? `${reason} Subscribe to keep going.` : `${reason} It starts again next period.`,
        settingsHref: UPGRADE_HREF,
      };
  }
}

/** Every one of the plan's cloud sessions is on a box already running. */
export function boxesDenial(plan: Plan, live: number): CloudLimitDenial | null {
  if (live < plan.concurrentCloudSessions) return null;
  return {
    error: `Your plan's ${plan.concurrentCloudSessions} concurrent cloud sessions are already running. End one to free its box (idle boxes pause within 15 minutes), or upgrade for more.`,
    settingsHref: UPGRADE_HREF,
  };
}

export type MeteredComputerRow = Pick<
  RuntimeComputer,
  "projectId" | "workspaceId" | "status" | "provider" | "updatedAt"
> & { pooled?: boolean; warmExpiresAt?: string | null };

/** Whether one of the owner's computers is a box the plan limits: running
 *  (ready, or provisioning while still fresh — a claim whose provision died
 *  holds no slot forever), and on Outrunner's sandboxes, not the owner's
 *  own Daytona or Modal. Mirrors live_metered_computers in
 *  supabase/migrations/20261019140000_plan_box_limits.sql; keep them
 *  together. */
export function isLiveMeteredComputer(computer: MeteredComputerRow, now: Date): boolean {
  if (computer.provider === "user-daytona" || computer.provider === "user-modal" || computer.provider === "user-gcp") return false;
  // Made ahead and stopped: running no one's session. An intent-warmed pool
  // box has a short lease and consumes the slot the imminent session will
  // inherit (20261103200000_intent_warm_pool.sql).
  if (computer.pooled && !computer.warmExpiresAt) return false;
  if (computer.status === "ready") return true;
  return (
    computer.status === "provisioning" &&
    now.getTime() - new Date(computer.updatedAt).getTime() < STALE_PROVISION_MS
  );
}

/** How many of the owner's boxes the plan limits are running at once. */
export function liveMeteredComputers(computers: readonly MeteredComputerRow[], now: Date): number {
  return computers.filter((computer) => isLiveMeteredComputer(computer, now)).length;
}

/** Whether the box of `scope` is one of the live ones: the session runs on
 *  it, and starts no box. A new session (no scope) always starts one. */
export function boxLive(
  computers: readonly MeteredComputerRow[],
  scope: ComputerScope | { warmProjectId: string } | null,
  now: Date,
): boolean {
  if (scope === null) return false;
  if ("warmProjectId" in scope) {
    return computers.some((computer) =>
      computer.projectId === scope.warmProjectId &&
      computer.pooled === true &&
      Boolean(computer.warmExpiresAt) &&
      isLiveMeteredComputer(computer, now),
    );
  }
  return computers.some((computer) => inScope(computer, scope) && isLiveMeteredComputer(computer, now));
}

/** Whether this login appears in the explicit plan-limit exemption list.
 *  Unlike the sign-in allowlist, an unset list exempts nobody. */
export function exemptFromPlanLimits(
  owner: Pick<Owner, "githubLogin">,
  allowlistRaw: string | undefined,
): boolean {
  const allowlist = parseAllowlist(allowlistRaw);
  return allowlist.has(owner.githubLogin.trim().toLowerCase());
}

/**
 * May this owner start another of Outrunner's boxes on `provider`, in `orgId`
 * (the session's: billing is the org's, so its plan, its hours and every
 * member's boxes count), for the box of `scope` (null: a new session's)? The refusal to answer with, or the
 * cap the claim in the database enforces (null: the owner's own sandbox, or
 * an owner the limits are not for). Called where a box may start: creating a
 * workspace, restoring one, and session attach bringing an ended box back.
 * The box count only refuses when that box isn't already live. Should it turn
 * out gone, the claim that replaces it still enforces the cap.
 */
export async function cloudBoxStartGate(
  owner: Owner,
  orgId: string,
  provider: ProviderName,
  scope: ComputerScope | { warmProjectId: string } | null,
): Promise<CloudBoxStartGate> {
  // Loaded here, not at the top, so the pure rules above stay testable in the
  // Node test runner: these pull Next's request scope (next/headers) through
  // lib/supabase/server, which tests have none of. lib/supabase/probe.ts
  // loads its client the same way.
  const [{ isMetered }, { accountStanding }, { runtimeComputersFor }, { isConnector }, { usageControlsFor }] =
    await Promise.all([
      import("@/lib/billing/metering-store"),
      import("@/lib/billing/standing"),
      import("@/lib/db/repositories"),
      import("@/lib/automations/connector"),
      import("@/lib/db/org-usage"),
    ]);
  if (!isMetered(provider)) return { cap: null };
  if (exemptFromPlanLimits(owner, optionalEnv("RUNTIME_PLAN_LIMIT_EXEMPT_GITHUB_LOGIN"))) {
    return { cap: null };
  }
  const now = new Date();
  // An org's connector, which its automations run as, is on its own plan,
  // paid by the deployment: its own usage and boxes, apart from the org's.
  const whose = (await isConnector(owner.id)) ? { ownerId: owner.id } : { orgId };
  // The admins' controls, read leniently: the defaults, said in the log,
  // rather than no box when they can't be read.
  const { plan, standing } = await accountStanding(whose, now, usageControlsFor);
  const denial = usageDenial(standing, plan);
  if (denial) return { denial };
  const computers = await runtimeComputersFor(whose);
  if (!boxLive(computers, scope, now)) {
    const boxes = boxesDenial(plan, liveMeteredComputers(computers, now));
    if (boxes) return { denial: boxes };
  }
  return { cap: plan.concurrentCloudSessions };
}
