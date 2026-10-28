/**
 * Real wiring for the usage sweep (lib/billing/usage-sweep.ts): the
 * database as the server, the deployment's provider to pause boxes, and
 * Resend for the admins' alerts.
 */

import { entitlementsFor } from "@/lib/billing/entitlements";
import { calendarMonth, hoursUsed } from "@/lib/billing/hours";
import { allRows, closeIntervalOf, intervalsFor, isMetered, markStoppedIfReady } from "@/lib/billing/metering-store";
import { hoursCap, USAGE_CONTROLS_HREF } from "@/lib/billing/usage-controls";
import { sweepOrgUsage, type UsageSweepReport } from "@/lib/billing/usage-sweep";
import { orgAdmins } from "@/lib/db/org-members";
import { claimAlert, getUsageControls, releaseAlert, sentAlerts } from "@/lib/db/org-usage";
import { getOrg } from "@/lib/db/orgs";
import { orgConnectorIds } from "@/lib/db/repositories";
import { canSendEmail, sendEmail } from "@/lib/email/send";
import { appUrl } from "@/lib/orgs/notify";
import type { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { computerMadeBy } from "@/lib/runtime/sandbox-choice";
import type { ProviderName } from "@/lib/runtime/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

type Row = { id: string; org_id: string; owner_id: string; daytona_sandbox_id: string | null; provider: string | null };

/** The metered boxes `provider` made, running now: every org's, or one's.
 *  Paged: there may be more than one response holds. */
async function runningMetered(provider: ComputerRuntimeProvider, orgId?: string): Promise<Row[]> {
  const rows = await allRows<Row>((from, to) => {
    let query = createSupabaseAdminClient()
      .from("runtime_computers")
      .select("id, org_id, owner_id, daytona_sandbox_id, provider")
      .eq("status", "ready")
      .eq("pooled", false)
      .not("daytona_sandbox_id", "is", null);
    if (orgId) query = query.eq("org_id", orgId);
    return query.order("id").range(from, to);
  });
  return rows.filter(
    (row) =>
      isMetered(row.provider as ProviderName | null) &&
      computerMadeBy({ provider: row.provider as ProviderName | null }) === provider.name,
  );
}

/** Not a box of an org's connector, which is on its own plan. */
async function notConnectors(rows: Row[]): Promise<Row[]> {
  const byOrg = new Map<string, Set<string>>();
  for (const orgId of new Set(rows.map((r) => r.org_id))) byOrg.set(orgId, await orgConnectorIds(orgId));
  return rows.filter((row) => !byOrg.get(row.org_id)?.has(row.owner_id));
}

export function runUsageSweep(provider: ComputerRuntimeProvider): Promise<UsageSweepReport> {
  const now = new Date();
  return sweepOrgUsage({
    async busyOrgs() {
      const orgIds = [...new Set((await notConnectors(await runningMetered(provider))).map((r) => r.org_id))];
      const teams: string[] = [];
      for (const orgId of orgIds) if ((await getOrg(orgId))?.personal === false) teams.push(orgId);
      return teams;
    },
    controls: getUsageControls,
    async entitlements(orgId) {
      const { plan, allowancePeriod } = await entitlementsFor(orgId, now);
      return { plan, period: allowancePeriod ?? calendarMonth(now) };
    },
    hoursUsed: async (orgId, period) => hoursUsed(await intervalsFor({ orgId }, period), period, now),
    sentAlerts: (orgId, period) => sentAlerts(orgId, period.start),
    claimAlert: (orgId, period, threshold) => claimAlert(orgId, period.start, threshold),
    releaseAlert: (orgId, period, threshold) => releaseAlert(orgId, period.start, threshold),
    canEmail: canSendEmail(),
    // A box that can't come back from a pause (a jcode engine's, or none)
    // runs on; the start gate refuses new ones.
    canPause: provider.pausesBoxes,
    async emailAdmins(orgId, threshold, used, plan, controls) {
      const [org, admins] = await Promise.all([getOrg(orgId), orgAdmins(orgId)]);
      const to = admins.flatMap((admin) => (admin.email ? [admin.email] : []));
      if (to.length === 0) return "nobody";
      const limit =
        controls.limitPercent === null
          ? ""
          : `\nIts usage limit is ${controls.limitPercent}% (${hoursCap(plan, controls)} hours): at it, no new cloud session starts and running ones pause.`;
      const sent = await sendEmail({
        to,
        subject: `${org?.name ?? "Your org"} has used ${threshold}% of its cloud hours`,
        text:
          `${org?.name ?? "Your org"} has used ${Math.round(used * 10) / 10} of its ${plan.label} plan's ${plan.cloudHoursPerMonth} cloud hours this period (${threshold}% or more).` +
          `${limit}\n\nChange the limit or these alerts: ${appUrl(USAGE_CONTROLS_HREF)}\n`,
      });
      return sent ? "sent" : "failed";
    },
    async runningBoxes(orgId) {
      return (await notConnectors(await runningMetered(provider, orgId))).map((row) => ({
        id: row.id,
        sandboxId: row.daytona_sandbox_id!,
      }));
    },
    async pause(box) {
      await provider.pauseComputer(box.sandboxId);
      await closeIntervalOf(box.sandboxId, new Date());
      await markStoppedIfReady(box.id, box.sandboxId, "Paused: the org's usage limit is reached.");
    },
    log: (message, error) => console.error(message, error),
  });
}
