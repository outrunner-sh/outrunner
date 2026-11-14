/**
 * Production wiring of overage billing (lib/billing/overage.ts): the
 * subscriptions table and the meter for what's owed, Stripe's invoice items
 * and invoices for billing it. Run by the reconciler's cron
 * (app/api/billing/reconcile/route.ts): reporting every ten minutes at most,
 * charging once a day, each under its own lease so two runs never overlap.
 */

import type Stripe from "stripe";

import { overageSubscriptions } from "@/lib/billing/billing-store";
import { intervalsFor, claimLease } from "@/lib/billing/metering-store";
import {
  chargeOverage,
  OVERAGE_KIND,
  type OverageDeps,
  type OverageItem,
  overageAccountsFrom,
  type OverageReport,
  REPORT_TAIL_MS,
  reportOverage,
} from "@/lib/billing/overage";
import { type PaidPlanId, PLANS } from "@/lib/billing/plans";
import { stripe } from "@/lib/billing/stripe";
import { usageCost, vcpuHoursUsed } from "@/lib/billing/usage";

const REPORT_LEASE_SECONDS = 9 * 60;
const CHARGE_LEASE_SECONDS = 23 * 60 * 60;

const PLANS_WITH_OVERAGE = (Object.keys(PLANS) as (keyof typeof PLANS)[]).filter(
  (id): id is PaidPlanId => id !== "free" && PLANS[id].usage.overage,
);

const unix = (date: Date) => Math.floor(date.getTime() / 1000);
const day = (date: Date) => date.toISOString().slice(0, 10);

export const overageDeps: OverageDeps = {
  accounts: async (now) =>
    overageAccountsFrom(await overageSubscriptions(PLANS_WITH_OVERAGE, new Date(now.getTime() - REPORT_TAIL_MS)), now),
  async overageCents(account, period, now) {
    const intervals = await intervalsFor({ orgId: account.orgId }, period);
    return usageCost(account.plan, vcpuHoursUsed(intervals, period, now)).overageCents;
  },
  async items(customerId, since) {
    const items: OverageItem[] = [];
    for await (const item of stripe().invoiceItems.list({
      customer: customerId,
      created: { gte: unix(since) },
      limit: 100,
      expand: ["data.invoice"],
    })) {
      if (item.metadata?.kind !== OVERAGE_KIND || !item.metadata.period_start) continue;
      const invoice = item.invoice as Stripe.Invoice | string | null;
      const status = typeof invoice === "string" ? null : invoice?.status;
      items.push({
        id: item.id,
        periodStart: item.metadata.period_start,
        amountCents: item.amount,
        state: invoice === null ? "pending" : status === "draft" ? "draft" : "invoiced",
      });
    }
    return items;
  },
  async setItemAmount(itemId, amountCents, idempotencyKey) {
    await stripe().invoiceItems.update(itemId, { amount: amountCents }, { idempotencyKey });
  },
  async createItem({ customerId, orgId, period, amountCents, idempotencyKey }) {
    await stripe().invoiceItems.create(
      {
        customer: customerId,
        amount: amountCents,
        currency: "usd",
        description: `Cloud usage overage, ${day(period.start)} to ${day(period.end)}`,
        metadata: { kind: OVERAGE_KIND, org_id: orgId, period_start: period.start.toISOString() },
      },
      { idempotencyKey },
    );
  },
  async chargePending({ customerId, orgId, idempotencyKey }) {
    const invoice = await stripe().invoices.create(
      {
        customer: customerId,
        pending_invoice_items_behavior: "include",
        collection_method: "charge_automatically",
        auto_advance: false,
        description: "Cloud usage overage",
        metadata: { kind: OVERAGE_KIND, org_id: orgId },
      },
      { idempotencyKey },
    );
    if (!invoice.id) throw new Error("Stripe made an overage invoice with no id.");
    const finalized = await stripe().invoices.finalizeInvoice(invoice.id, {}, { idempotencyKey: `${idempotencyKey}:finalize` });
    if (finalized.status !== "open") return;
    // A declined card is an answer, not a failure here: Stripe sends
    // invoice.payment_failed, which marks the overage unpaid
    // (lib/billing/sync.ts), and retries the card on its schedule.
    await stripe()
      .invoices.pay(invoice.id, {}, { idempotencyKey: `${idempotencyKey}:pay` })
      .catch((error: unknown) => {
        if ((error as { type?: string }).type !== "StripeCardError") throw error;
      });
  },
  log: (message, error) => (error === undefined ? console.warn(message) : console.error(message, error)),
};

export type OverageRun = { reported: OverageReport | null; charged: OverageReport | null };

/** One cron tick's overage billing: reported when ten minutes have passed
 *  since the last report, and charged when a day has since the last charge. */
export async function runOverageBilling(now = new Date()): Promise<OverageRun> {
  const reported = (await claimLease("overage-report", REPORT_LEASE_SECONDS)) ? await reportOverage(overageDeps, now) : null;
  const charged = (await claimLease("overage-charge", CHARGE_LEASE_SECONDS)) ? await chargeOverage(overageDeps, now) : null;
  return { reported, charged };
}
