import Stripe from "stripe";

import { requireEnv } from "@/lib/env";

let client: Stripe | null = null;

/** The Stripe client, on STRIPE_SECRET_KEY. Lazy, so the build and the tests
 *  need no key. */
export function stripe(): Stripe {
  client ??= new Stripe(requireEnv("STRIPE_SECRET_KEY"));
  return client;
}
