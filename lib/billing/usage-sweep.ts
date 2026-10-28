/**
 * The reconciler's look at each busy team org's cloud hours against its
 * admins' controls (lib/billing/usage-controls.ts): email its admins at each
 * alert threshold crossed, once per period; and at its limit, pause its
 * running boxes, as the start gate already refuses new ones. Only orgs with
 * a box running: hours grow only while one does. The I/O is behind
 * {@link UsageSweepDeps}.
 */

import type { Period } from "@/lib/billing/hours";
import type { Plan } from "@/lib/billing/plans";
import { alertsDue, overLimit, type UsageControls } from "@/lib/billing/usage-controls";

export type RunningBox = { id: string; sandboxId: string };

export type UsageSweepDeps = {
  /** Team orgs with a metered box running (not their connector's). */
  busyOrgs(): Promise<string[]>;
  controls(orgId: string): Promise<UsageControls>;
  /** The org's plan and the period its hours are counted over. */
  entitlements(orgId: string): Promise<{ plan: Plan; period: Period }>;
  hoursUsed(orgId: string, period: Period): Promise<number>;
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
  runningBoxes(orgId: string): Promise<RunningBox[]>;
  pause(box: RunningBox): Promise<void>;
  log(message: string, error?: unknown): void;
};

export type UsageSweepReport = { orgs: number; alerts: number; paused: number; failed: number };

export async function sweepOrgUsage(deps: UsageSweepDeps): Promise<UsageSweepReport> {
  const report: UsageSweepReport = { orgs: 0, alerts: 0, paused: 0, failed: 0 };
  for (const orgId of await deps.busyOrgs()) {
    try {
      const controls = await deps.controls(orgId);
      if (controls.limitPercent === null && controls.alertThresholds.length === 0) continue;
      report.orgs += 1;
      const { plan, period } = await deps.entitlements(orgId);
      const used = await deps.hoursUsed(orgId, period);
      const due = deps.canEmail ? alertsDue(plan, controls, used, await deps.sentAlerts(orgId, period)) : [];
      for (const threshold of due) {
        // Claimed first: of two runs at once, one emails.
        if (!(await deps.claimAlert(orgId, period, threshold))) continue;
        // A throw is a failure too: the claim goes back, and the org's limit
        // is still looked at below.
        const outcome = await deps.emailAdmins(orgId, threshold, used, plan, controls).catch((error: unknown) => {
          deps.log(`Usage alert: couldn't email org ${orgId}'s admins`, error);
          return "failed" as const;
        });
        if (outcome === "sent") report.alerts += 1;
        if (outcome === "failed") await deps.releaseAlert(orgId, period, threshold);
      }
      if (deps.canPause && overLimit(plan, controls, used)) {
        for (const box of await deps.runningBoxes(orgId)) {
          try {
            await deps.pause(box);
            report.paused += 1;
          } catch (error) {
            deps.log(`Usage limit: couldn't pause box ${box.sandboxId} of org ${orgId}`, error);
            report.failed += 1;
          }
        }
      }
    } catch (error) {
      // One org's trouble doesn't stop the rest.
      deps.log(`Usage sweep: org ${orgId} failed`, error);
      report.failed += 1;
    }
  }
  return report;
}
