import { billingMode } from "@/lib/billing/mode";
import { PLANS, type Plan } from "@/lib/billing/plans";

/**
 * The plan a user is on, which every limit is read from. With billing off,
 * everyone is on Free.
 */
export async function planFor(userId: string): Promise<Plan> {
  switch (billingMode()) {
    case "off":
      return PLANS.free;
    case "stripe":
      // billingMode() refuses "stripe" until subscriptions are read.
      throw new Error(`No subscription to read a plan from for user ${userId}.`);
  }
}
