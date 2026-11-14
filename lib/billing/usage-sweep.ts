/**
 * The reconciler's look at the cloud hours of everyone with a box running:
 * every org (personal or team), and each org's connector, which is on its own
 * plan. Past the plan's hours, its running boxes pause, as the start gate
 * (lib/billing/limits.ts) already refuses new ones: otherwise a box started
 * at 99% ran on, and billed, for as long as it was used. A team org's admins'
 * controls (lib/billing/usage-controls.ts) add theirs: an email at each alert
 * threshold crossed, once per period, and a pause at their limit below the
 * plan's. Only accounts with a box running: hours grow only while one does.
 * Boxes of an owner exempt from plan limits
 * (RUNTIME_PLAN_LIMIT_EXEMPT_GITHUB_LOGIN) run on, as they start. The I/O is
 * behind {@link UsageSweepDeps}.
 */

import type { Period } from "@/lib/billing/hours";
import type { Plan } from "@/lib/billing/plans";
import { FORCED_PAUSE_NOTICE_PREFIX } from "@/lib/billing/reconcile";
import { alertsDue, overLimit, type UsageControls } from "@/lib/billing/usage-controls";

/** Whose hours: an org's (every member's boxes but its connector's), or an
 *  org's connector's, on its own plan. Only a team org has admins' controls. */
export type Account = { kind: "team" | "personal"; orgId: string } | { kind: "connector"; ownerId: string };

export type RunningBox = { id: string; sandboxId: string; ownerId: string; workspaceId: string | null };

export type UsageSweepDeps = {
  /** Accounts with a metered box running. */
  busyAccounts(): Promise<Account[]>;
  controls(orgId: string): Promise<UsageControls>;
  /** The account's plan and the period its hours are counted over. */
  entitlements(account: Account): Promise<{ plan: Plan; period: Period }>;
  hoursUsed(account: Account, period: Period): Promise<number>;
  sentAlerts(orgId: string, period: Period): Promise<Set<number>>;
  /** Record the alert; false when another run did first. */
  claimAlert(orgId: string, period: Period, threshold: number): Promise<boolean>;
  /** Take the record back: the email didn't go, so a later run tries again. */
  releaseAlert(orgId: string, period: Period, threshold: number): Promise<void>;
  /** Whether the deployment can send email at all: without it, no alert is
   *  claimed, so none is lost. */
  canEmail: boolean;
  /** "sent"; "failed" (tried again later); or "nobody" (no admin has an
   *  email: nothing to try again). */
  emailAdmins(
    orgId: string,
    threshold: number,
    used: number,
    plan: Plan,
    controls: UsageControls,
  ): Promise<"sent" | "failed" | "nobody">;
  /** Whether running boxes can be paused here: where they can't, the start
   *  gate's refusal is the limit, and running ones run on. */
  canPause: boolean;
  runningBoxes(account: Account): Promise<RunningBox[]>;
  /** Whether the box's owner is exempt from plan limits. */
  exempt(ownerId: string): Promise<boolean>;
  /** Pause it, its session told `reason`. */
  pause(box: RunningBox, reason: string): Promise<void>;
  log(message: string, error?: unknown): void;
};

export type UsageSweepReport = { orgs: number; alerts: number; paused: number; failed: number };

/** What a session paused at a limit says: why, and what to do. Starting
 *  FORCED_PAUSE_NOTICE_PREFIX, the session shows it until its box runs. */
export function planHoursReason(plan: Plan, account: Account["kind"] = "personal"): string {
  // Only a member's org can upgrade, and only to a plan with more hours: a
  // connector is on the deployment's plan, and Max and Enterprise top out.
  const upgradable = account !== "connector" && (plan.id === "free" || plan.id === "pro");
  const next = upgradable ? "upgrade for more hours, or it can start again next period" : "it can start again next period";
  return `${FORCED_PAUSE_NOTICE_PREFIX}: the plan's ${plan.cloudHoursPerMonth} cloud hours are used up for this period. Its files are kept; ${next}.`;
}
export function orgLimitReason(plan: Plan, controls: UsageControls): string {
  return `${FORCED_PAUSE_NOTICE_PREFIX}: the org's usage limit (${controls.limitPercent}% of its plan's ${plan.cloudHoursPerMonth} cloud hours) is reached for this period. Its files are kept; an admin can raise the limit in Settings → Org → Usage.`;
}

/** Why the account's boxes pause now, or null while it's within its hours.
 *  Past both, the plan's: raising the admins' limit wouldn't help. */
export function pauseReason(
  plan: Plan,
  controls: UsageControls | null,
  used: number,
  account: Account["kind"] = "personal",
): string | null {
  if (plan.cloudHoursPerMonth !== null && used >= plan.cloudHoursPerMonth) return planHoursReason(plan, account);
  if (controls && overLimit(plan, controls, used)) return orgLimitReason(plan, controls);
  return null;
}

function label(account: Account): string {
  return account.kind === "connector" ? `connector ${account.ownerId}` : `org ${account.orgId}`;
}

export async function sweepOrgUsage(deps: UsageSweepDeps): Promise<UsageSweepReport> {
  const report: UsageSweepReport = { orgs: 0, alerts: 0, paused: 0, failed: 0 };
  for (const account of await deps.busyAccounts()) {
    try {
      report.orgs += 1;
      const controls = account.kind === "team" ? await deps.controls(account.orgId) : null;
      const { plan, period } = await deps.entitlements(account);
      const used = await deps.hoursUsed(account, period);
      if (account.kind === "team" && controls) {
        const due = deps.canEmail ? alertsDue(plan, controls, used, await deps.sentAlerts(account.orgId, period)) : [];
        for (const threshold of due) {
          // Claimed first: of two runs at once, one emails.
          if (!(await deps.claimAlert(account.orgId, period, threshold))) continue;
          // A throw is a failure too: the claim goes back, and the org's limit
          // is still looked at below.
          const outcome = await deps
            .emailAdmins(account.orgId, threshold, used, plan, controls)
            .catch((error: unknown) => {
              deps.log(`Usage alert: couldn't email org ${account.orgId}'s admins`, error);
              return "failed" as const;
            });
          if (outcome === "sent") report.alerts += 1;
          if (outcome === "failed") await deps.releaseAlert(account.orgId, period, threshold);
        }
      }
      const reason = deps.canPause ? pauseReason(plan, controls, used, account.kind) : null;
      if (!reason) continue;
      for (const box of await deps.runningBoxes(account)) {
        try {
          // As the start gate: an exempt owner's boxes aren't limited.
          if (await deps.exempt(box.ownerId)) continue;
          deps.log(
            `Usage limit: pausing workspace ${box.workspaceId ?? "none"} (box ${box.sandboxId}) of ${label(account)}: ${Math.round(used * 10) / 10} of ${plan.cloudHoursPerMonth} hours used`,
          );
          await deps.pause(box, reason);
          report.paused += 1;
        } catch (error) {
          deps.log(`Usage limit: couldn't pause box ${box.sandboxId} of ${label(account)}`, error);
          report.failed += 1;
        }
      }
    } catch (error) {
      // One account's trouble doesn't stop the rest.
      deps.log(`Usage sweep: ${label(account)} failed`, error);
      report.failed += 1;
    }
  }
  return report;
}
