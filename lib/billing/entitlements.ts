import { subscriptionsFor } from "@/lib/billing/billing-store";
import { personalOrgId } from "@/lib/db/orgs";
import type { Period } from "@/lib/billing/hours";
import { billingMode } from "@/lib/billing/mode";
import { isConnector } from "@/lib/automations/connector";
import { allowancePeriod, monthlyPeriod } from "@/lib/billing/periods";
import { connectorPlan, DEFAULT_AUTOMATION_MODEL_ALLOWANCE_USD, PLANS, type Plan } from "@/lib/billing/plans";
import { optionalEnv } from "@/lib/env";
import { currentSubscription, planFromSubscriptions } from "@/lib/billing/subscriptions";

export type Entitlements = {
  plan: Plan;
  /** The month the plan's allowances are in (lib/billing/periods.ts); null on
   *  Free, whose model allowance is once. */
  allowancePeriod: Period | null;
};

/**
 * What an org is entitled to now (billing is the org's): with billing off,
 * Free for everyone; with Stripe, the best plan its subscriptions give it
 * (lib/billing/subscriptions.ts), and its period.
 */
export async function entitlementsFor(orgId: string, now = new Date()): Promise<Entitlements> {
  if (billingMode() === "off") return { plan: PLANS.free, allowancePeriod: null };
  const subscriptions = await subscriptionsFor(orgId);
  const plan = planFromSubscriptions(subscriptions, now);
  const subscription = currentSubscription(subscriptions, now);
  return {
    plan,
    allowancePeriod: subscription ? allowancePeriod(subscription, now) : null,
  };
}

/** The plan an org is on, which every limit its members share is read from;
 *  Free for none (its orgs couldn't be read). */
export async function planFor(orgId: string | undefined): Promise<Plan> {
  return orgId ? (await entitlementsFor(orgId)).plan : PLANS.free;
}

/** The plan a session of `userId`'s in `orgId` runs within: the org's, or,
 *  for its connector (its automations), the connector's own. */
export async function sessionPlan(userId: string, orgId: string): Promise<Plan> {
  return (await isConnector(userId)) ? (await personalEntitlements(userId)).plan : planFor(orgId);
}

/** A user's personal org's entitlements: what sets their own model key's
 *  allowance until it is the org's (an org's connector's: its own). Free
 *  without one. */
export async function personalEntitlements(userId: string, now = new Date()): Promise<Entitlements> {
  // An org's connector, which its automations run as, billing on or off:
  // its own plan, renewed each calendar month.
  if (await isConnector(userId)) {
    return { plan: connectorPlan(automationModelAllowanceUsd()), allowancePeriod: connectorPeriod(now) };
  }
  const orgId = await personalOrgId(userId);
  return orgId ? entitlementsFor(orgId, now) : { plan: PLANS.free, allowancePeriod: null };
}

/** The connector's allowance period: the calendar month (UTC) `now` is in. */
export function connectorPeriod(now: Date): Period {
  return monthlyPeriod(new Date(Date.UTC(2000, 0, 1)), now);
}

/** AUTOMATION_MODEL_ALLOWANCE_USD, a positive number of dollars a month;
 *  DEFAULT_AUTOMATION_MODEL_ALLOWANCE_USD otherwise. */
export function automationModelAllowanceUsd(): number {
  const value = Number(optionalEnv("AUTOMATION_MODEL_ALLOWANCE_USD"));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_AUTOMATION_MODEL_ALLOWANCE_USD;
}
