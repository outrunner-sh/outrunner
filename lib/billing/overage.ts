/**
 * Billing the usage past a plan's included amount (lib/billing/usage.ts) to
 * Stripe, as Replicas does: overage builds up on one pending invoice item a
 * period, kept equal to what's owed; once a day, $50 or more pending is
 * charged at once, and anything less rides the renewal invoice, which pulls
 * a customer's pending items in. Once a subscription has ended, what's left
 * is charged straight away.
 *
 * Stripe's invoice items are the record: what a period has owed is its
 * overage, what earlier items already put on invoices is subtracted, and the
 * open item is set to the rest. Setting an amount rather than adding to one
 * makes a retried or repeated run harmless, so no cursor is kept here. The
 * I/O is behind {@link OverageDeps}.
 */

import type { Period } from "@/lib/billing/hours";
import { allowancePeriod, periodBefore } from "@/lib/billing/periods";
import { type Plan, PLANS } from "@/lib/billing/plans";
import { currentSubscription, stillBills, type SubscriptionRecord } from "@/lib/billing/subscriptions";

/** The kind every overage invoice item and invoice carries in its metadata,
 *  which is how the webhook (lib/billing/sync.ts) and the reads know them. */
export const OVERAGE_KIND = "overage";

/** Pending overage at least this is charged at once, not at renewal. */
export const CHARGE_AT_CENTS = 5000;

/** How long after a period ends its overage is still reported: the end of
 *  the period's usage arrives with the next runs, and the renewal webhook
 *  that moves the period can lag. */
export const REPORT_TAIL_MS = 48 * 60 * 60_000;

/** An org whose plan bills overage. */
export type OverageAccount = {
  orgId: string;
  customerId: string;
  plan: Plan;
  /** The periods to report, oldest first: the one just ended, within
   *  REPORT_TAIL_MS of its end, and the one now (none once it has ended). */
  periods: Period[];
  /** Whether its subscription has ended: what's pending is charged now,
   *  whatever the amount. */
  ended: boolean;
};

/** One of Outrunner's overage invoice items: `pending` (on no invoice yet),
 *  on a `draft` invoice (the renewal's, still changeable), or `invoiced`. */
export type OverageItem = {
  id: string;
  /** The start of the period it bills, as an ISO string. */
  periodStart: string;
  amountCents: number;
  state: "pending" | "draft" | "invoiced";
};

export type OverageDeps = {
  accounts(now: Date): Promise<OverageAccount[]>;
  /** The account's overage in `period` up to `now`, in cents. */
  overageCents(account: OverageAccount, period: Period, now: Date): Promise<number>;
  /** The customer's overage items made since `since`. */
  items(customerId: string, since: Date): Promise<OverageItem[]>;
  setItemAmount(itemId: string, amountCents: number, idempotencyKey: string): Promise<void>;
  createItem(input: {
    customerId: string;
    orgId: string;
    period: Period;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<void>;
  /** Invoice the customer's pending items and charge it now. */
  chargePending(input: { customerId: string; orgId: string; idempotencyKey: string }): Promise<void>;
  log(message: string, error?: unknown): void;
};

/** A period's open item, and what it should hold: the period's overage less
 *  what its items already put on invoices (never below nothing). */
export function openItemTarget(
  overageCents: number,
  items: readonly OverageItem[],
): { open: OverageItem | null; targetCents: number; invoicedCents: number } {
  const invoicedCents = items.filter((i) => i.state === "invoiced").reduce((sum, i) => sum + i.amountCents, 0);
  const open = items.find((i) => i.state !== "invoiced") ?? null;
  return { open, targetCents: Math.max(0, overageCents - invoicedCents), invoicedCents };
}

export type OverageReport = { accounts: number; created: number; updated: number; charged: number; failed: number };

const emptyReport = (): OverageReport => ({ accounts: 0, created: 0, updated: 0, charged: 0, failed: 0 });

/** Bring each account's open overage items up to what it owes. */
export async function reportOverage(deps: OverageDeps, now: Date): Promise<OverageReport> {
  const report = emptyReport();
  for (const account of await deps.accounts(now)) {
    report.accounts += 1;
    try {
      if (account.periods.length === 0) continue;
      const items = await deps.items(account.customerId, account.periods[0].start);
      for (const period of account.periods) {
        const periodStart = period.start.toISOString();
        const overage = await deps.overageCents(account, period, now);
        const { open, targetCents, invoicedCents } = openItemTarget(overage, items.filter((i) => i.periodStart === periodStart));
        // Keyed by what the call does, so a retry of it is the same call:
        // an item set to an amount; a period's next item after what's
        // already invoiced.
        if (open) {
          if (open.amountCents === targetCents) continue;
          await deps.setItemAmount(open.id, targetCents, `overage-set:${open.id}:${targetCents}`);
          report.updated += 1;
        } else if (targetCents > 0) {
          await deps.createItem({
            customerId: account.customerId,
            orgId: account.orgId,
            period,
            amountCents: targetCents,
            idempotencyKey: `overage-create:${account.orgId}:${periodStart}:${invoicedCents}:${targetCents}`,
          });
          report.created += 1;
        }
      }
    } catch (error) {
      // One account's trouble doesn't stop the rest; the next run sets it right.
      deps.log(`Overage: reporting org ${account.orgId} failed`, error);
      report.failed += 1;
    }
  }
  return report;
}

/** Charge each account's pending overage now where it's CHARGE_AT_CENTS or
 *  more, or where the subscription has ended. Run once a day, after
 *  reportOverage. */
export async function chargeOverage(deps: OverageDeps, now: Date): Promise<OverageReport> {
  const report = emptyReport();
  for (const account of await deps.accounts(now)) {
    report.accounts += 1;
    try {
      if (account.periods.length === 0) continue;
      const pending = (await deps.items(account.customerId, account.periods[0].start)).filter((i) => i.state === "pending");
      const cents = pending.reduce((sum, i) => sum + i.amountCents, 0);
      if (cents <= 0 || (cents < CHARGE_AT_CENTS && !account.ended)) continue;
      const ids = pending.map((i) => i.id).sort().join(",");
      await deps.chargePending({ customerId: account.customerId, orgId: account.orgId, idempotencyKey: `overage-charge:${ids}:${cents}` });
      report.charged += 1;
    } catch (error) {
      deps.log(`Overage: charging org ${account.orgId} failed`, error);
      report.failed += 1;
    }
  }
  return report;
}

/** Since when an overage invoice has been failing: the earliest open one
 *  whose payment was tried; null when none is. */
export function unpaidSinceOf(openInvoices: readonly { created: Date; attempted: boolean }[]): Date | null {
  return openInvoices
    .filter((i) => i.attempted)
    .reduce<Date | null>((earliest, i) => (earliest === null || i.created < earliest ? i.created : earliest), null);
}

/**
 * The accounts overage is billed for, from their orgs' subscriptions: the
 * org's current subscription where its plan bills overage, with the period
 * now and, within REPORT_TAIL_MS of a renewal, the one before; else, for an
 * org with none current, its latest subscription on such a plan that ended
 * within REPORT_TAIL_MS, for that last period. An org on a plan without
 * overage owes none.
 */
export function overageAccountsFrom(subscriptions: readonly SubscriptionRecord[], now: Date): OverageAccount[] {
  const byOrg = new Map<string, SubscriptionRecord[]>();
  for (const s of subscriptions) byOrg.set(s.orgId, [...(byOrg.get(s.orgId) ?? []), s]);
  const accounts: OverageAccount[] = [];
  for (const [orgId, subs] of byOrg) {
    const current = currentSubscription(subs, now);
    if (current) {
      const plan = PLANS[current.plan];
      if (!plan.usage.overage) continue;
      const period = allowancePeriod(current, now);
      const periods = now.getTime() - period.start.getTime() < REPORT_TAIL_MS ? [periodBefore(period), period] : [period];
      accounts.push({ orgId, customerId: current.stripeCustomerId, plan, periods, ended: false });
      continue;
    }
    const last = subs
      .filter((s) => PLANS[s.plan].usage.overage && now.getTime() - s.currentPeriodEnd.getTime() < REPORT_TAIL_MS)
      .reduce<SubscriptionRecord | null>((latest, s) => (latest && latest.currentPeriodEnd >= s.currentPeriodEnd ? latest : s), null);
    if (!last) continue;
    const end = new Date(Math.min(now.getTime(), last.currentPeriodEnd.getTime() - 1));
    accounts.push({
      orgId,
      customerId: last.stripeCustomerId,
      plan: PLANS[last.plan],
      periods: [allowancePeriod(last, end)],
      ended: !stillBills(last.status),
    });
  }
  return accounts;
}
