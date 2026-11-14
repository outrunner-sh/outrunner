/**
 * Allowance periods. A paid plan's allowances renew monthly from the day it
 * started, yearly plans included: a year paid up front still renews its
 * allowance month by month, never a year's worth at once. Pure.
 */

import type { Period } from "@/lib/billing/hours";
import type { SubscriptionRecord } from "@/lib/billing/subscriptions";

/**
 * The month a subscription's allowances are in at `now`. A monthly plan's is
 * the period Stripe bills: its recorded boundaries, which Stripe keeps on the
 * subscription's anchor day (anchored on the 31st, February ends on March
 * 31, not March 28); until the renewal's webhook moves them, the period
 * stays the one recorded, so nothing renews early. A yearly plan's are the
 * months of its year, counted from the year's start, which stays put all
 * year.
 */
export function allowancePeriod(
  subscription: Pick<SubscriptionRecord, "billingInterval" | "currentPeriodStart" | "currentPeriodEnd">,
  now: Date,
): Period {
  if (subscription.billingInterval === "month") {
    return { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd };
  }
  return monthlyPeriod(subscription.currentPeriodStart, now);
}

/**
 * The month-long period, counted from `anchor`, that `now` is in. A month
 * that is too short for the anchor's day ends on its last day, as Stripe
 * bills: anchored on the 31st, February's period starts on the 28th or 29th.
 */
export function monthlyPeriod(anchor: Date, now: Date): Period {
  let months =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  if (addMonths(anchor, months) > now) months -= 1;
  return { start: addMonths(anchor, months), end: addMonths(anchor, months + 1) };
}

/** `date` plus `months`, on the same day and time, or the month's last day. */
function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/** The month-long period just before `period`: the one ending where it
 *  starts, counted back from its start's day (lib/billing/overage.ts reports
 *  its tail after a renewal). */
export function periodBefore(period: Period): Period {
  return monthlyPeriod(period.start, new Date(period.start.getTime() - 1));
}
