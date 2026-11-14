"use client";

import { PageHeader } from "@/components/page-layout";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { PlanIncludes, PlanPrice } from "@/components/plan-parts";
import { LoadingButton, type ActionStatus } from "@/components/ui/loading-button";
import { InlineMessage, Notice } from "@/components/ui/notice";
import { stripePage } from "@/lib/billing/client";
import { type BillingInterval, type Plan, PLANS } from "@/lib/billing/plans";
import { formatUsd, INCLUDED_CENTS_PER_VCPU_HOUR, OVERAGE_CENTS_PER_VCPU_HOUR } from "@/lib/billing/usage";
import { BOX_SIZES } from "@/lib/runtime/box-sizes";
import { isDesktopApp } from "@/lib/is-desktop";

/** The subscription the plan comes from, as the page shows it. */
export type ShownSubscription = {
  status: string;
  interval: BillingInterval | null;
  /** ISO time the period ends: renewal, or the end of a cancelled plan. */
  periodEnd: string;
  cancelAtPeriodEnd: boolean;
};

/** How long the page waits for Stripe's webhook after a checkout. */
const CONFIRM_FOR_MS = 30_000;
const CONFIRM_EVERY_MS = 2_000;

/**
 * Settings → Billing: the user's plan and what it includes, and Stripe's own
 * pages to start, change or cancel one. Prices and rates come from plans.ts
 * and usage.ts, so the page never waits on Stripe. `forSale` is false where
 * plans aren't sold (billing off).
 */
export function BillingSettings({
  plan,
  subscription,
  forSale,
  hasCustomer,
  checkout,
  org = null,
}: {
  /** The org whose plan it is (billing is the org's); none before orgs. */
  org?: { name: string; personal: boolean; admin: boolean } | null;
  plan: Plan;
  subscription: ShownSubscription | null;
  forSale: boolean;
  hasCustomer: boolean;
  checkout: "success" | "canceled" | "error" | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  // In the Mac app Stripe opens in the browser and comes back there, not
  // here: this page stays, so it says so and reads the plan again on return.
  const [inBrowser, setInBrowser] = useState(false);

  useEffect(() => {
    if (!inBrowser) return;
    const reread = () => router.refresh();
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, [inBrowser, router]);
  // Back from Checkout before Stripe's webhook has landed: ask again until
  // the plan shows, then stop.
  const confirming = checkout === "success" && plan.id === "free" && !gaveUp;

  useEffect(() => {
    if (!confirming) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > CONFIRM_FOR_MS) {
        setGaveUp(true);
        return;
      }
      router.refresh();
    }, CONFIRM_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [confirming, router]);

  /** POST to one of the billing routes and go where it says (Stripe's page;
   *  the Mac app opens it in the browser). */
  async function go(action: string, path: string, body?: object) {
    setPending(action);
    try {
      const url = await stripePage(path, body);
      setFailed(null);
      setError(null);
      window.location.assign(url);
      if (isDesktopApp()) {
        setInBrowser(true);
        setPending(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Stripe's page didn't open.");
      setFailed(action);
      setPending(null);
    }
  }
  const status = (action: string): ActionStatus =>
    pending === action ? "pending" : failed === action ? "error" : "idle";

  return (
    <section className="space-y-8">
      <div className="space-y-1">
        <PageHeader title={"Billing"} />
        <p className="text-sm text-muted-foreground">
          {!org || org.personal
            ? "Your plan, and what it includes."
            : `${org.name}'s plan, and what it includes: shared by all its members, whoever starts a session.`}
        </p>
      </div>
      {org && !org.admin ? (
        <p className="text-sm text-muted-foreground">{`Only ${org.name}'s admins change its plan.`}</p>
      ) : null}

      {checkout === "canceled" ? <Notice tone="info" title="Checkout canceled" detail="Nothing was charged." /> : null}
      {checkout === "error" ? (
        <Notice tone="error" title="Stripe's checkout didn't open" detail="Nothing was charged. Try again below." />
      ) : null}
      {inBrowser ? (
        <Notice
          tone="info"
          title="Stripe opened in your browser"
          detail="Finish there; your plan shows here when you come back."
        />
      ) : null}
      {checkout === "success" && plan.id !== "free" ? (
        <Notice tone="info" title={`You're on ${plan.label}`} detail="Thanks!" />
      ) : null}
      {confirming ? <Notice tone="progress" title="Confirming your payment with Stripe…" /> : null}
      {checkout === "success" && plan.id === "free" && gaveUp ? (
        <Notice
          tone="warning"
          title="Your payment is still being confirmed"
          detail="Reload this page in a minute."
        />
      ) : null}

      <div className="space-y-3 rounded-lg border border-border/60 p-4">
        <div className="flex items-baseline justify-between gap-4">
          <p className="text-sm font-medium text-foreground">{plan.label}</p>
          {subscription ? <p className="text-xs text-muted-foreground">{subscriptionLine(subscription)}</p> : null}
        </div>
        <PlanIncludes plan={plan} />
        {hasCustomer && (!org || org.admin) ? (
          <LoadingButton
            variant="outline"
            status={status("portal")}
            labels={{ idle: "Manage billing", pending: "Opening Stripe…" }}
            onClick={() => void go("portal", "/api/billing/portal")}
          />
        ) : null}
        {failed === "portal" && error ? <InlineMessage>{error}</InlineMessage> : null}
      </div>

      {org && !org.admin ? null : forSale ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {(["pro", "max"] as const).map((id) => {
              const offered = PLANS[id];
              const price = offered.priceUsd;
              const current = plan.id === id;
              return (
                <div key={id} className="space-y-3 rounded-lg border border-border/60 p-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">{offered.label}</p>
                    {price !== null ? <PlanPrice usd={price} /> : null}
                  </div>
                  <PlanIncludes plan={offered} />
                  <LoadingButton
                    status={status(id)}
                    disabled={current || price === null}
                    labels={{
                      idle: current ? "Current plan" : plan.id === "free" ? `Upgrade to ${offered.label}` : `Switch to ${offered.label}`,
                      pending: "Opening Stripe…",
                    }}
                    onClick={() => void go(id, "/api/billing/checkout", { plan: id })}
                  />
                  {failed === id && error ? <InlineMessage>{error} Nothing was charged.</InlineMessage> : null}
                </div>
              );
            })}
          </div>
          <RatesTable />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Plans aren&apos;t for sale on this server.</p>
      )}

    </section>
  );
}

/** A box's per-minute price at `centsPerVcpuHour`: "$0.004". */
function perMinute(cpu: number, centsPerVcpuHour: number): string {
  return `$${((cpu * centsPerVcpuHour) / 6000).toFixed(3)}`;
}

/** Per-minute rates by box size, included and past the included usage. */
function RatesTable() {
  const pro = formatUsd((PLANS.pro.priceUsd ?? 0) * 100);
  const max = formatUsd((PLANS.max.priceUsd ?? 0) * 100);
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">Per-minute rates</p>
      <table className="w-full max-w-md text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 pr-4 font-normal">Box</th>
            <th className="py-1 pr-4 font-normal">Included</th>
            <th className="py-1 font-normal">After included usage</th>
          </tr>
        </thead>
        <tbody className="text-foreground">
          {BOX_SIZES.map((size) => (
            <tr key={size.id}>
              <td className="py-1 pr-4">{`${size.label} (${size.cpu} vCPU, ${size.memoryGb} GB)`}</td>
              <td className="py-1 pr-4">{perMinute(size.cpu, INCLUDED_CENTS_PER_VCPU_HOUR)} / min</td>
              <td className="py-1">{perMinute(size.cpu, OVERAGE_CENTS_PER_VCPU_HOUR)} / min</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">
        {`Boxes are billed only while they run, at least a minute a session. Pro includes ${pro} and Max ${max} of usage a month; set a limit in Settings → Org → Usage.`}
      </p>
    </div>
  );
}

function subscriptionLine(subscription: ShownSubscription): string {
  const date = new Date(subscription.periodEnd).toLocaleDateString(undefined, { dateStyle: "medium" });
  if (subscription.status === "past_due") return "Payment failed: update your card in Manage billing";
  if (subscription.cancelAtPeriodEnd) return `Ends ${date}`;
  return `Renews ${date}${subscription.interval === "year" ? ", yearly" : ""}`;
}
