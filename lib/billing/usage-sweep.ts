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
  emailAdmins(orgId: string, threshold: number, used: number, plan: Plan, controls: UsageControls): Promise<void>;
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
      for (const threshold of alertsDue(plan, controls, used, await deps.sentAlerts(orgId, period))) {
        // Claimed first: of two runs at once, one emails.
        if (await deps.claimAlert(orgId, period, threshold)) {
          await deps.emailAdmins(orgId, threshold, used, plan, controls);
          report.alerts += 1;
        }
      }
      if (overLimit(plan, controls, used)) {
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
