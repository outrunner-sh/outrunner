# Overage billing

Pro and Max include cloud usage worth their price. Past it, usage is billed at
the overage rate, 1.5x the included rate (`lib/billing/usage.ts`). This page
explains how that overage reaches Stripe and how to check it end to end in
test mode.

## How it works

The reconciler's cron (`app/api/billing/reconcile/route.ts`, every 2
minutes) runs `runOverageBilling` (`lib/billing/overage.deps.ts`) when
`RUNTIME_BILLING=stripe`:

- **Report**, at most every 10 minutes (lease `overage-report`): for each org
  on a plan with overage, its overage for the period is priced from
  `compute_intervals`. One pending Stripe invoice item per period, with
  metadata `kind=overage`, `org_id` and `period_start`, is set to what's owed
  less what earlier items already put on invoices. For 48 hours after a
  renewal, the period just ended is reported too.
- **Charge**, once a day (lease `overage-charge`): an org with $50 or more
  pending gets an invoice for its pending items (metadata `kind=overage`),
  finalized and charged at once; a declined card is retried on the account's
  Smart Retries schedule. Less than $50 rides the renewal invoice,
  which pulls a customer's pending items in. Once a subscription has ended,
  what's left is charged whatever the amount.
- **Unpaid**: `invoice.payment_failed`, `invoice.paid`, `invoice.voided` and
  `invoice.marked_uncollectible` on an overage invoice set or clear
  `subscriptions.overage_unpaid_since` from the customer's open overage
  invoices (`lib/billing/sync.ts`). While it's set, no box starts or wakes;
  running ones carry on (`lib/billing/standing.ts`).

Stripe's invoice items are the record: nothing is stored here beyond the
unpaid mark. Each call sets an absolute amount under an idempotency key named
for what it does, so a retried or repeated run changes nothing.

## Checking it in test mode

With test-mode keys on staging and a Pro subscription bought through
Checkout (card `4242 4242 4242 4242`):

1. In the Stripe dashboard, attach a **test clock** to the customer
   (Billing → Test clocks) before subscribing, or make a new customer on one.
2. Run boxes past the included $20, or insert `compute_intervals` rows for
   the org, and wait for a reconcile tick. The customer gets a pending invoice
   item "Cloud usage overage, ..." equal to the org's overage on Settings → Org
   → Usage.
3. Push the overage past $50, then advance the clock a day. The next tick
   makes, finalizes and pays an invoice with `kind=overage`.
4. Change the customer's card to `4000 0000 0000 0341` (attaches, then
   declines) and repeat step 3. `invoice.payment_failed` arrives, Settings →
   Org → Usage shows the unpaid notice, and a new session is refused with a
   link to Billing. Pay the invoice in the dashboard, and the notice clears.
5. Leave less than $50 pending and advance the clock past the renewal. The
   renewal invoice includes the pending item.
6. Cancel the subscription at period end and advance past it. Within 48
   hours, the last period's remaining overage is invoiced on its own.
