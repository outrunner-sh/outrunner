/**
 * Renewing model allowances for sessions already running. A new period's
 * allowance is otherwise given when a session starts, the sidebar reads it,
 * or a subscription changes; a yearly plan's months turn over with none of
 * those, and its key would stay on last month's cap. The reconciler's cron
 * runs this every couple of minutes.
 */

import { allowancePeriod } from "@/lib/billing/periods";
import { currentSubscription, type SubscriptionRecord } from "@/lib/billing/subscriptions";

/**
 * The users whose stored allowance period isn't the one their plan is in
 * now. `storedPeriods` has an entry for each user with a key of Outrunner's
 * (null: no period stored yet); one without a key has nothing to renew.
 */
export function dueForRenewal(
  subscriptions: readonly SubscriptionRecord[],
  storedPeriods: ReadonlyMap<string, string | null>,
  now: Date,
): string[] {
  const byUser = new Map<string, SubscriptionRecord[]>();
  for (const subscription of subscriptions) {
    byUser.set(subscription.userId, [...(byUser.get(subscription.userId) ?? []), subscription]);
  }
  const due: string[] = [];
  for (const [userId, theirs] of byUser) {
    if (!storedPeriods.has(userId)) continue;
    const current = currentSubscription(theirs, now);
    if (!current) continue;
    if (storedPeriods.get(userId) !== allowancePeriod(current, now).start.toISOString()) due.push(userId);
  }
  return due;
}
