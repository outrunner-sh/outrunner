/**
 * Allowance periods. A paid plan's allowances renew monthly from the day it
 * started, yearly plans included: a year paid up front still renews its
 * allowance month by month, never a year's worth at once. Pure.
 */

import type { Period } from "@/lib/billing/hours";

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
