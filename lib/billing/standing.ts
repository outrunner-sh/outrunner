/**
 * Where an account's cloud usage leaves it now: its plan, the period, its
 * admins' controls, and its standing (lib/billing/usage.ts). The one read
 * of all that, for the start gate (lib/billing/limits.ts), the usage sweep
 * (lib/billing/usage-sweep.deps.ts) and Settings → Org → Usage, so the three
 * can't count it differently.
 */

import { overageUnpaidSince } from "@/lib/billing/billing-store";
import { entitlementsFor, personalEntitlements } from "@/lib/billing/entitlements";
import type { Period } from "@/lib/billing/hours";
import { intervalsFor } from "@/lib/billing/metering-store";
import { billingMode } from "@/lib/billing/mode";
import type { Plan } from "@/lib/billing/plans";
import { usageCost, usagePeriod, usageStanding, type UsageStanding, vcpuHoursUsed } from "@/lib/billing/usage";
import { DEFAULT_USAGE_CONTROLS, limitFor, type UsageControls } from "@/lib/billing/usage-controls";

/** Whose usage: an org's (every member's boxes but its connector's), or an
 *  org's connector's, on its own plan, with no controls and nothing unpaid
 *  (the deployment pays for it). */
export type Whose = { orgId: string } | { ownerId: string };

export type AccountStanding = {
  plan: Plan;
  period: Period;
  controls: UsageControls;
  standing: UsageStanding;
};

/** `whose` usage now. `readControls` reads an org's controls: the start
 *  gate's falls back to the defaults (a box rather than none), while the
 *  sweep's throws, so a failed read never emails alerts an admin turned off. */
export async function accountStanding(
  whose: Whose,
  now: Date,
  readControls: (orgId: string) => Promise<UsageControls>,
): Promise<AccountStanding> {
  const { plan, allowancePeriod } =
    "ownerId" in whose ? await personalEntitlements(whose.ownerId, now) : await entitlementsFor(whose.orgId, now);
  const period = usagePeriod(plan, allowancePeriod, now, billingMode());
  const [intervals, controls, unpaidSince] = await Promise.all([
    intervalsFor(whose, period),
    "orgId" in whose ? readControls(whose.orgId) : DEFAULT_USAGE_CONTROLS,
    "orgId" in whose ? unpaidSinceFor(whose.orgId) : null,
  ]);
  const cost = usageCost(plan, vcpuHoursUsed(intervals, period, now));
  return { plan, period, controls, standing: usageStanding({ plan, cost, limitUsd: limitFor(plan, controls), unpaidSince }) };
}

/** Since when the org's overage payment has been failing. When that can't
 *  be read, said in the log, it reads as paid: a database blip doesn't stop
 *  every box, and Stripe still holds the debt. */
function unpaidSinceFor(orgId: string): Promise<Date | null> {
  return overageUnpaidSince(orgId).catch((error: unknown) => {
    console.error(`Couldn't read org ${orgId}'s unpaid overage; treating it as paid`, error);
    return null;
  });
}
