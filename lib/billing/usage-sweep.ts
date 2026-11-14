/**
 * The reconciler's look at the cloud usage of everyone with a box running:
 * every org (personal or team), and each org's connector, which is on its own
 * plan. Where usage stops the account (lib/billing/usage.ts: the trial's
 * credit or a fixed plan's included usage spent, or the admins' limit
 * reached), its running boxes pause, as the start gate
 * (lib/billing/limits.ts) already refuses new ones: otherwise a box started
 * just under it ran on, and billed, for as long as it was used. An unpaid
 * overage refuses new boxes but pauses none. An org's admins are emailed at
 * each alert threshold its usage crosses, once per period
 * (lib/billing/usage-controls.ts). Only accounts with a box running: usage
 * grows only while one does. Boxes of an owner exempt from plan limits
 * (RUNTIME_PLAN_LIMIT_EXEMPT_GITHUB_LOGIN) run on, as they start. The I/O is
 * behind {@link UsageSweepDeps}.
 */

import type { Period } from "@/lib/billing/hours";
import { usageReason } from "@/lib/billing/limits";
import { FORCED_PAUSE_NOTICE_PREFIX } from "@/lib/billing/reconcile";
import type { AccountStanding } from "@/lib/billing/standing";
import { formatUsd, pausesRunning } from "@/lib/billing/usage";
import { alertsDue } from "@/lib/billing/usage-controls";

/** Whose usage: an org's (every member's boxes but its connector's), or an
 *  org's connector's, on its own plan. Only an org has admins' controls. */
export type Account = { kind: "team" | "personal"; orgId: string } | { kind: "connector"; ownerId: string };

export type RunningBox = { id: string; sandboxId: string; ownerId: string; workspaceId: string | null };

export type UsageSweepDeps = {
  /** Accounts with a metered box running. */
  busyAccounts(): Promise<Account[]>;
  /** Where the account's usage leaves it (lib/billing/standing.ts). */
  standing(account: Account): Promise<AccountStanding>;
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
  emailAdmins(orgId: string, threshold: number, account: AccountStanding): Promise<"sent" | "failed" | "nobody">;
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

/** What a session paused for its account's usage says, starting
 *  FORCED_PAUSE_NOTICE_PREFIX (the session shows it until its box runs):
 *  why, and what to do. Null where usage doesn't pause boxes. */
export function pauseReason({ plan, standing }: AccountStanding): string | null {
  const reason = usageReason(standing, plan);
  if (!reason || !pausesRunning(standing.state)) return null;
  const next =
    standing.state === "at_limit"
      ? "an admin can raise the limit in Settings → Org → Usage"
      : plan.id === "free"
        ? "subscribe to keep going"
        : "it can start again next period";
  return `${FORCED_PAUSE_NOTICE_PREFIX}: ${reason.charAt(0).toLowerCase()}${reason.slice(1)} Its files are kept; ${next}.`;
}

function label(account: Account): string {
  return account.kind === "connector" ? `connector ${account.ownerId}` : `org ${account.orgId}`;
}

export async function sweepOrgUsage(deps: UsageSweepDeps): Promise<UsageSweepReport> {
  const report: UsageSweepReport = { orgs: 0, alerts: 0, paused: 0, failed: 0 };
  for (const account of await deps.busyAccounts()) {
    try {
      report.orgs += 1;
      const standing = await deps.standing(account);
      if (account.kind !== "connector") {
        const sent = deps.canEmail ? await deps.sentAlerts(account.orgId, standing.period) : null;
        const due = sent ? alertsDue(standing.plan, standing.standing, standing.controls, sent) : [];
        for (const threshold of due) {
          // Claimed first: of two runs at once, one emails.
          if (!(await deps.claimAlert(account.orgId, standing.period, threshold))) continue;
          // A throw is a failure too: the claim goes back, and the pause is
          // still looked at below.
          const outcome = await deps.emailAdmins(account.orgId, threshold, standing).catch((error: unknown) => {
            deps.log(`Usage alert: couldn't email org ${account.orgId}'s admins`, error);
            return "failed" as const;
          });
          if (outcome === "sent") report.alerts += 1;
          if (outcome === "failed") await deps.releaseAlert(account.orgId, standing.period, threshold);
        }
      }
      const reason = deps.canPause ? pauseReason(standing) : null;
      if (!reason) continue;
      for (const box of await deps.runningBoxes(account)) {
        try {
          // As the start gate: an exempt owner's boxes aren't limited.
          if (await deps.exempt(box.ownerId)) continue;
          deps.log(
            `Usage limit: pausing workspace ${box.workspaceId ?? "none"} (box ${box.sandboxId}) of ${label(account)}: ${standing.standing.state} at ${formatUsd(standing.standing.totalCents)}`,
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
