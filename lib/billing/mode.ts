/**
 * Whether this deployment bills through Stripe (RUNTIME_BILLING).
 *
 *   - "off": no one pays and everyone is on the Free plan, which is what every
 *     user had before billing: Outrunner's limits still hold, there is just
 *     nothing to buy. The default outside production.
 *   - "stripe": plans come from users' Stripe subscriptions, kept by the
 *     webhook. Needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.
 *
 * Explicit on purpose: a missing Stripe key must not quietly decide what users
 * get, so production refuses to start without the setting (server.ts asks at
 * boot). Imports nothing, so server.ts can load it before Next.
 */

export type BillingMode = "off" | "stripe";

export class BillingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingConfigError";
  }
}

export function billingMode(env: Record<string, string | undefined> = process.env): BillingMode {
  const value = env.RUNTIME_BILLING?.trim();
  if (!value) {
    if (env.NODE_ENV === "production") {
      throw new BillingConfigError('RUNTIME_BILLING is required in production: set it to "off" or "stripe".');
    }
    return "off";
  }
  if (value === "off") return "off";
  if (value === "stripe") {
    const missing = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"].filter((key) => !env[key]?.trim());
    if (missing.length > 0) {
      throw new BillingConfigError(`RUNTIME_BILLING="stripe" needs ${missing.join(" and ")}.`);
    }
    return "stripe";
  }
  throw new BillingConfigError(`Invalid RUNTIME_BILLING "${value}". Expected "off" or "stripe".`);
}
