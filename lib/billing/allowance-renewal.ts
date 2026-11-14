/**
 * Renewing model allowances for sessions already running. A new period's
 * allowance is otherwise given when a session starts, the sidebar reads it,
 * or a subscription changes; a yearly plan's months turn over with none of
 * those, and its key would stay on last month's cap. The reconciler's cron
 * runs this every couple of minutes.
 */

import { allowancePeriod } from "@/lib/billing/periods";
import { PLANS } from "@/lib/billing/plans";
import { currentSubscription, type SubscriptionRecord } from "@/lib/billing/subscriptions";

/**
 * The holders of a model key whose stored allowance period isn't the one
 * their plan is in now. `holderOf` says whose key a subscription's plan sets
 * (null: none's). `storedPeriods` has an entry for each holder with a key of
 * Outrunner's (null: no period stored yet); one without a key has nothing to
 * renew.
 */
export function dueForRenewal(
  subscriptions: readonly SubscriptionRecord[],
  holderOf: (subscription: SubscriptionRecord) => string | null,
  storedPeriods: ReadonlyMap<string, string | null>,
  now: Date,
): string[] {
  const byUser = new Map<string, SubscriptionRecord[]>();
  for (const subscription of subscriptions) {
    const holder = holderOf(subscription);
    if (holder) byUser.set(holder, [...(byUser.get(holder) ?? []), subscription]);
  }
  const due: string[] = [];
  for (const [userId, theirs] of byUser) {
    if (!storedPeriods.has(userId)) continue;
    const current = currentSubscription(theirs, now);
    if (!current) continue;
    // A plan with unlimited models (none today; Max was until usage-based
    // billing) is reconciled within the period too: a capped key moving onto
    // it loses its cap, and a failed OpenRouter patch is retried.
    if (
      PLANS[current.plan].models.usd === null ||
      storedPeriods.get(userId) !== allowancePeriod(current, now).start.toISOString()
    )
      due.push(userId);
  }
  return due;
}
