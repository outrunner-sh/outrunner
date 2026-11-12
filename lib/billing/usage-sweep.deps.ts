/**
 * Real wiring for the usage sweep (lib/billing/usage-sweep.ts): the
 * database as the server, the deployment's provider to pause boxes, and
 * Resend for the admins' alerts.
 */

import { githubLogin } from "@/lib/auth/allowlist";
import { entitlementsFor, personalEntitlements } from "@/lib/billing/entitlements";
import { calendarMonth, hoursUsed } from "@/lib/billing/hours";
import { exemptFromPlanLimits } from "@/lib/billing/limits";
import {
  allRows,
  closeIntervalOf,
  intervalsFor,
  isMetered,
  markStoppedIfReady,
  noticeWorkspace,
} from "@/lib/billing/metering-store";
import { hoursCap, USAGE_CONTROLS_HREF } from "@/lib/billing/usage-controls";
import { type Account, sweepOrgUsage, type UsageSweepReport } from "@/lib/billing/usage-sweep";
import { orgAdmins } from "@/lib/db/org-members";
import { claimAlert, getUsageControls, releaseAlert, sentAlerts } from "@/lib/db/org-usage";
import { getOrg } from "@/lib/db/orgs";
import { orgConnectorIds } from "@/lib/db/repositories";
import { canSendEmail, sendEmail } from "@/lib/email/send";
import { optionalEnv } from "@/lib/env";
import { appUrl } from "@/lib/orgs/notify";
import type { ComputerRuntimeProvider } from "@/lib/runtime/computer-provider";
import { computerMadeBy } from "@/lib/runtime/sandbox-choice";
import type { ProviderName } from "@/lib/runtime/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

type Row = {
  id: string;
  org_id: string;
  owner_id: string;
  workspace_id: string | null;
  daytona_sandbox_id: string | null;
  provider: string | null;
};

/** The metered boxes `provider` made, running now: every one, an org's, or
 *  one owner's. Paged: there may be more than one response holds. Not the
 *  warm pool's, which are made by a refill's gate (lib/runtime/warm-pool.deps.ts). */
async function runningMetered(
  provider: ComputerRuntimeProvider,
  filter: { orgId?: string; ownerId?: string } = {},
): Promise<Row[]> {
  const rows = await allRows<Row>((from, to) => {
    let query = createSupabaseAdminClient()
      .from("runtime_computers")
      .select("id, org_id, owner_id, workspace_id, daytona_sandbox_id, provider")
      .eq("status", "ready")
      .eq("pooled", false)
      .not("daytona_sandbox_id", "is", null);
    if (filter.orgId) query = query.eq("org_id", filter.orgId);
    if (filter.ownerId) query = query.eq("owner_id", filter.ownerId);
    return query.order("id").range(from, to);
  });
  return rows.filter(
    (row) =>
      isMetered(row.provider as ProviderName | null) &&
      computerMadeBy({ provider: row.provider as ProviderName | null }) === provider.name,
  );
}

/** Each org's connector ids, read once a run. */
function connectorsOf(): (orgId: string) => Promise<Set<string>> {
  const byOrg = new Map<string, Promise<Set<string>>>();
  return (orgId) => {
    if (!byOrg.has(orgId)) byOrg.set(orgId, orgConnectorIds(orgId));
    return byOrg.get(orgId)!;
  };
}

export function runUsageSweep(provider: ComputerRuntimeProvider): Promise<UsageSweepReport> {
  const now = new Date();
  const connectors = connectorsOf();
  const exemptList = optionalEnv("RUNTIME_PLAN_LIMIT_EXEMPT_GITHUB_LOGIN");
  const exemptByOwner = new Map<string, Promise<boolean>>();
  return sweepOrgUsage({
    async busyAccounts() {
      const accounts: Account[] = [];
      const orgs = new Set<string>();
      const connectorOwners = new Set<string>();
      for (const row of await runningMetered(provider)) {
        if ((await connectors(row.org_id)).has(row.owner_id)) connectorOwners.add(row.owner_id);
        else orgs.add(row.org_id);
      }
      for (const orgId of orgs) {
        const org = await getOrg(orgId);
        // An org that can't be read is still looked at, as a personal one
        // (no admins' controls): its plan's hours still apply.
        accounts.push({ kind: org?.personal === false ? "team" : "personal", orgId });
      }
      for (const ownerId of connectorOwners) accounts.push({ kind: "connector", ownerId });
      return accounts;
    },
    controls: getUsageControls,
    async entitlements(account) {
      const { plan, allowancePeriod } =
        account.kind === "connector" ? await personalEntitlements(account.ownerId, now) : await entitlementsFor(account.orgId, now);
      return { plan, period: allowancePeriod ?? calendarMonth(now) };
    },
    hoursUsed: async (account, period) =>
      hoursUsed(
        await intervalsFor(account.kind === "connector" ? { ownerId: account.ownerId } : { orgId: account.orgId }, period),
        period,
        now,
      ),
    sentAlerts: (orgId, period) => sentAlerts(orgId, period.start),
    claimAlert: (orgId, period, threshold) => claimAlert(orgId, period.start, threshold),
    releaseAlert: (orgId, period, threshold) => releaseAlert(orgId, period.start, threshold),
    canEmail: canSendEmail(),
    // A box that can't come back from a pause (a provider without pause and restore)
    // runs on; the start gate refuses new ones.
    canPause: provider.pausesBoxes,
    async emailAdmins(orgId, threshold, used, plan, controls) {
      const [org, admins] = await Promise.all([getOrg(orgId), orgAdmins(orgId)]);
      const to = admins.flatMap((admin) => (admin.email ? [admin.email] : []));
      if (to.length === 0) return "nobody";
      const limit =
        controls.limitPercent === null
          ? ""
          : `\nIts usage limit is ${controls.limitPercent}% (${hoursCap(plan, controls)} hours): at it, no new cloud session starts${
              provider.pausesBoxes ? ", and running ones pause" : ""
            }.`;
      const sent = await sendEmail({
        to,
        subject: `${org?.name ?? "Your org"} has used ${threshold}% of its cloud hours`,
        text:
          `${org?.name ?? "Your org"} has used ${Math.round(used * 10) / 10} of its ${plan.label} plan's ${plan.cloudHoursPerMonth} cloud hours this period (${threshold}% or more).` +
          `${limit}\nAt 100%, no new cloud session starts${provider.pausesBoxes ? " and running ones pause" : ""} until the next period or an upgrade.` +
          `\n\nChange the limit or these alerts: ${appUrl(USAGE_CONTROLS_HREF)}\n`,
      });
      return sent ? "sent" : "failed";
    },
    async runningBoxes(account) {
      const rows =
        account.kind === "connector"
          ? await runningMetered(provider, { ownerId: account.ownerId })
          : await runningMetered(provider, { orgId: account.orgId });
      const mine = [];
      for (const row of rows) {
        const isConnector = (await connectors(row.org_id)).has(row.owner_id);
        if (isConnector === (account.kind === "connector")) mine.push(row);
      }
      return mine.map((row) => ({
        id: row.id,
        sandboxId: row.daytona_sandbox_id!,
        ownerId: row.owner_id,
        workspaceId: row.workspace_id,
      }));
    },
    exempt(ownerId) {
      // Unset: nobody is exempt, and no one need be looked up.
      if (!exemptList?.trim()) return Promise.resolve(false);
      if (!exemptByOwner.has(ownerId)) {
        exemptByOwner.set(
          ownerId,
          createSupabaseAdminClient()
            .auth.admin.getUserById(ownerId)
            .then(({ data, error }) => {
              if (error) throw error;
              const login = data.user ? githubLogin(data.user) : null;
              return login !== null && exemptFromPlanLimits({ githubLogin: login }, exemptList);
            }),
        );
      }
      return exemptByOwner.get(ownerId)!;
    },
    async pause(box, reason) {
      await provider.pauseComputer(box.sandboxId);
      await closeIntervalOf(box.sandboxId, new Date());
      await markStoppedIfReady(box.id, box.sandboxId, reason);
      await noticeWorkspace(box.workspaceId, reason).catch((error: unknown) =>
        console.error(`Usage limit: couldn't tell workspace ${box.workspaceId} why its box was paused`, error),
      );
    },
    log: (message, error) => (error === undefined ? console.warn(message) : console.error(message, error)),
  });
}
