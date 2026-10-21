"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { LoadingButton, type ActionStatus } from "@/components/ui/loading-button";
import { InlineMessage, Notice } from "@/components/ui/notice";
import { isDesktopApp } from "@/lib/is-desktop";
import { requestJson } from "@/lib/http/request-json";
import { type BillingInterval, LOOKUP_KEYS, type Plan, PLANS } from "@/lib/billing/plans";
import { boxSize } from "@/lib/runtime/box-sizes";
import { cn } from "@/lib/utils";

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
 * pages to start, change or cancel one. `prices` is null where plans aren't
 * sold (billing off); a price Stripe didn't give is left out.
 */
export function BillingSettings({
  plan,
  subscription,
  prices,
  hasCustomer,
  checkout,
}: {
  plan: Plan;
  subscription: ShownSubscription | null;
  prices: Record<string, number> | null;
  hasCustomer: boolean;
  checkout: "success" | "canceled" | "error" | null;
}) {
  const router = useRouter();
  const [interval, setBillingInterval] = useState<BillingInterval>(subscription?.interval ?? "month");
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
      const data = await requestJson<{ url: string }>(path, {
        method: "POST",
        body,
        has: (d) => Boolean(d.url),
        fallback: "Stripe's page didn't open.",
      });
      setFailed(null);
      setError(null);
      window.location.assign(data.url);
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
        <h1 className="text-xl font-semibold text-foreground">Billing</h1>
        <p className="text-sm text-muted-foreground">Your plan, and what it includes.</p>
      </div>

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
        <Includes plan={plan} />
        {hasCustomer ? (
          <LoadingButton
            variant="outline"
            status={status("portal")}
            labels={{ idle: "Manage billing", pending: "Opening Stripe…" }}
            onClick={() => void go("portal", "/api/billing/portal")}
          />
        ) : null}
        {failed === "portal" && error ? <InlineMessage>{error}</InlineMessage> : null}
      </div>

      {prices ? (
        <div className="space-y-4">
          <div role="radiogroup" aria-label="Billing interval" className="inline-flex rounded-md border border-border/60 p-0.5">
            {(["month", "year"] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={interval === option}
                onClick={() => setBillingInterval(option)}
                className={cn(
                  "rounded px-3 py-1 text-sm transition-colors",
                  interval === option ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option === "month" ? "Monthly" : "Yearly · 2 months free"}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {(["pro", "max"] as const).map((id) => {
              const offered = PLANS[id];
              const price = prices[LOOKUP_KEYS[id][interval]];
              const current = plan.id === id;
              return (
                <div key={id} className="space-y-3 rounded-lg border border-border/60 p-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">{offered.label}</p>
                    {price !== undefined ? (
                      <p className="text-sm text-foreground">
                        ${price}
                        <span className="text-xs text-muted-foreground"> / {interval === "month" ? "month" : "year"}</span>
                      </p>
                    ) : null}
                  </div>
                  <Includes plan={offered} />
                  <LoadingButton
                    status={status(id)}
                    disabled={current || price === undefined}
                    labels={{
                      idle: current ? "Current plan" : plan.id === "free" ? `Upgrade to ${offered.label}` : `Switch to ${offered.label}`,
                      pending: "Opening Stripe…",
                    }}
                    onClick={() => void go(id, "/api/billing/checkout", { plan: id, interval })}
                  />
                  {failed === id && error ? <InlineMessage>{error} Nothing was charged.</InlineMessage> : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Plans aren&apos;t for sale on this server.</p>
      )}

    </section>
  );
}

/** What a plan includes. The model allowance is never shown in dollars. */
function Includes({ plan }: { plan: Plan }) {
  return (
    <ul className="space-y-1 text-xs text-muted-foreground">
      <li>{plan.cloudHoursPerMonth} cloud hours a month</li>
      <li>
        {plan.concurrentCloudSessions} cloud sessions at once, up to {boxSize(plan.largestBoxSize).label} boxes
      </li>
      <li>{plan.models.per === "once" ? "Outrunner's models, to try" : "Outrunner's models, usage included"}</li>
    </ul>
  );
}

function subscriptionLine(subscription: ShownSubscription): string {
  const date = new Date(subscription.periodEnd).toLocaleDateString(undefined, { dateStyle: "medium" });
  if (subscription.status === "past_due") return "Payment failed: update your card in Manage billing";
  if (subscription.cancelAtPeriodEnd) return `Ends ${date}`;
  return `Renews ${date}${subscription.interval === "year" ? ", yearly" : ""}`;
}
