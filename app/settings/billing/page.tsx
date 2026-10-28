import { redirect } from "next/navigation";
import { Suspense } from "react";

import { BillingSettings, type ShownSubscription } from "@/components/billing-settings";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { customerIdFor, subscriptionsFor } from "@/lib/billing/billing-store";
import { billingMode } from "@/lib/billing/mode";
import { PLANS } from "@/lib/billing/plans";
import { listedPricesUsd } from "@/lib/billing/stripe-deps";
import { currentSubscription, planFromSubscriptions } from "@/lib/billing/subscriptions";
import { getOrgContext } from "@/lib/orgs/server";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

type SearchParams = Promise<{ checkout?: string }>;

/** Settings → Billing: the plan of the org the user is looking at (billing
 *  is the org's), and, for its admins, Stripe's pages to change it. */
export default function BillingSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<SettingsLoading title="Billing" />}>
      <BillingSection searchParams={searchParams} />
    </Suspense>
  );
}

async function BillingSection({ searchParams }: { searchParams: SearchParams }) {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/billing");
  const { checkout } = await searchParams;
  const active = (await getOrgContext().catch(() => undefined))?.active;
  if (!active) {
    return (
      <section className="space-y-6">
        <h1 className="text-lg font-semibold text-foreground">Billing</h1>
        <p className="text-sm text-muted-foreground">Couldn&apos;t load your orgs. Reload the page to try again.</p>
      </section>
    );
  }
  const org = { name: active.name, personal: active.personal, admin: active.role === "admin" };

  if (billingMode() !== "stripe") {
    return (
      <BillingSettings org={org} plan={PLANS.free} subscription={null} prices={null} hasCustomer={false} checkout={null} />
    );
  }

  const now = new Date();
  const [subscriptions, customerId, prices] = await Promise.all([
    subscriptionsFor(active.id),
    customerIdFor(active.id),
    // The page still shows the plan when Stripe can't be reached for prices.
    listedPricesUsd().catch((error: unknown) => {
      console.error("Could not read prices from Stripe", error);
      return {};
    }),
  ]);
  const current = currentSubscription(subscriptions, now);
  const subscription: ShownSubscription | null = current && {
    status: current.status,
    interval: current.billingInterval,
    periodEnd: current.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: current.cancelAtPeriodEnd,
  };
  return (
    <BillingSettings
      org={org}
      plan={planFromSubscriptions(subscriptions, now)}
      subscription={subscription}
      prices={prices}
      hasCustomer={customerId !== null}
      checkout={checkout === "success" || checkout === "canceled" || checkout === "error" ? checkout : null}
    />
  );
}
