/**
 * Whether this deployment bills through Stripe (RUNTIME_BILLING).
 *
 *   - "off": no one pays and everyone is on the Free plan, which is what every
 *     user had before billing: Outrunner's limits still hold, there is just
 *     nothing to buy. The default outside production.
 *   - "stripe": plans come from users' Stripe subscriptions.
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
    // Subscriptions aren't read yet; until they are, "stripe" would bill no one
    // while saying it does.
    throw new BillingConfigError('RUNTIME_BILLING="stripe" isn\'t supported by this build yet: set it to "off".');
  }
  throw new BillingConfigError(`Invalid RUNTIME_BILLING "${value}". Expected "off" or "stripe".`);
}
