import { redirect } from "next/navigation";
import { Suspense } from "react";

import { BillingSettings, type ShownSubscription } from "@/components/billing-settings";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwner } from "@/lib/auth/owner";
import { customerIdFor, subscriptionsFor } from "@/lib/billing/billing-store";
import { billingMode } from "@/lib/billing/mode";
import { PLANS } from "@/lib/billing/plans";
import { listedPricesUsd } from "@/lib/billing/stripe-deps";
import { currentSubscription, planFromSubscriptions } from "@/lib/billing/subscriptions";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

type SearchParams = Promise<{ checkout?: string }>;

/** Settings → Billing: the user's plan, and Stripe's pages to change it. */
export default function BillingSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<SettingsLoading title="Billing" />}>
      <BillingSection searchParams={searchParams} />
    </Suspense>
  );
}

async function BillingSection({ searchParams }: { searchParams: SearchParams }) {
  const owner = await getOwner();
  if (!owner) redirect("/signin?next=/settings/billing");
  const { checkout } = await searchParams;

  if (billingMode() !== "stripe") {
    return <BillingSettings plan={PLANS.free} subscription={null} prices={null} hasCustomer={false} checkout={null} />;
  }

  const now = new Date();
  const [subscriptions, customerId, prices] = await Promise.all([
    subscriptionsFor(owner.id),
    customerIdFor(owner.id),
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
      plan={planFromSubscriptions(subscriptions, now)}
      subscription={subscription}
      prices={prices}
      hasCustomer={customerId !== null}
      checkout={checkout === "success" || checkout === "canceled" || checkout === "error" ? checkout : null}
    />
  );
}
