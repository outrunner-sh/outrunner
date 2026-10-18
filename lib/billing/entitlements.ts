import { subscriptionsFor } from "@/lib/billing/billing-store";
import { billingMode } from "@/lib/billing/mode";
import { PLANS, type Plan } from "@/lib/billing/plans";
import { planFromSubscriptions } from "@/lib/billing/subscriptions";

/**
 * The plan a user is on, which every limit is read from: with billing off,
 * Free for everyone; with Stripe, the best their subscriptions give them now
 * (lib/billing/subscriptions.ts).
 */
export async function planFor(userId: string): Promise<Plan> {
  switch (billingMode()) {
    case "off":
      return PLANS.free;
    case "stripe":
      return planFromSubscriptions(await subscriptionsFor(userId), new Date());
  }
}
