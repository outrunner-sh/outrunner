import { PageHeader } from "@/components/page-layout";

import { redirect } from "next/navigation";
import { Suspense } from "react";

import { BillingSettings, type ShownSubscription } from "@/components/billing-settings";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { customerIdFor, subscriptionsFor } from "@/lib/billing/billing-store";
import { billingMode } from "@/lib/billing/mode";
import { PLANS } from "@/lib/billing/plans";
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
        <PageHeader title={"Billing"} />
        <p className="text-sm text-muted-foreground">Couldn&apos;t load your orgs. Reload the page to try again.</p>
      </section>
    );
  }
  const org = { name: active.name, personal: active.personal, admin: active.role === "admin" };

  if (billingMode() !== "stripe") {
    return (
      <BillingSettings org={org} plan={PLANS.free} subscription={null} forSale={false} hasCustomer={false} checkout={null} />
    );
  }

  const now = new Date();
  const [subscriptions, customerId] = await Promise.all([subscriptionsFor(active.id), customerIdFor(active.id)]);
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
      forSale
      hasCustomer={customerId !== null}
      checkout={checkout === "success" || checkout === "canceled" || checkout === "error" ? checkout : null}
    />
  );
}
