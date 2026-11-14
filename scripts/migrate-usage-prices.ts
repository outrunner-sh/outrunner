/**
 * Move every subscription still on a price from before usage-based billing
 * to the monthly usage prices (lib/billing/price-migration.ts): monthly ones
 * from their next renewal, yearly ones now with the unused year credited.
 *
 * Dry run by default: it lists what it would change. With --apply it changes
 * them, one Stripe call each, under an idempotency key, so a rerun after a
 * failure only does what's left. Email customers before applying.
 *
 *   node --experimental-strip-types --import ./scripts/test-loader.mjs \
 *        --env-file=.env.local scripts/migrate-usage-prices.ts [--apply]
 *
 * Needs STRIPE_SECRET_KEY with write access to Subscriptions; the new prices
 * (LOOKUP_KEYS) must exist at the amounts plans.ts sets.
 */

import Stripe from "stripe";

import { assertPlanPrice } from "@/lib/billing/checkout";
import { LOOKUP_KEYS } from "@/lib/billing/plans";
import { priceMoveFor } from "@/lib/billing/price-migration";

const apply = process.argv.includes("--apply");
const key = process.env.STRIPE_SECRET_KEY;
if (!key) throw new Error("Set STRIPE_SECRET_KEY.");
const stripe = new Stripe(key);

const prices = new Map<string, string>();
for (const plan of ["pro", "max"] as const) {
  const found = (await stripe.prices.list({ lookup_keys: [LOOKUP_KEYS[plan]], active: true, limit: 1 })).data[0];
  if (!found) throw new Error(`No active Stripe price has the lookup key ${LOOKUP_KEYS[plan]}.`);
  assertPlanPrice(plan, found.unit_amount);
  prices.set(LOOKUP_KEYS[plan], found.id);
}

let moved = 0;
let failed = 0;
for await (const subscription of stripe.subscriptions.list({ status: "all", limit: 100, expand: ["data.items.data.price"] })) {
  const item = subscription.items.data[0];
  if (!item) continue;
  const move = priceMoveFor({
    id: subscription.id,
    status: subscription.status,
    itemId: item.id,
    lookupKey: item.price.lookup_key ?? null,
    interval: item.price.recurring?.interval ?? null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  });
  if (!move) continue;
  const line = `${move.subscriptionId} (${item.price.lookup_key} → ${move.toLookupKey}, proration ${move.proration})`;
  if (!apply) {
    console.log(`would move ${line}`);
    continue;
  }
  try {
    await stripe.subscriptions.update(
      move.subscriptionId,
      { items: [{ id: move.itemId, price: prices.get(move.toLookupKey)! }], proration_behavior: move.proration },
      { idempotencyKey: `price-move:${move.subscriptionId}:${move.toLookupKey}` },
    );
    console.log(`moved ${line}`);
    moved += 1;
  } catch (error) {
    console.error(`failed ${line}`, error);
    failed += 1;
  }
}
console.log(apply ? `Moved ${moved}, failed ${failed}.` : "Dry run: nothing changed. Rerun with --apply.");
