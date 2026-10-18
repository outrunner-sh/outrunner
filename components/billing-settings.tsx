"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { LoadingButton, type ActionStatus } from "@/components/ui/loading-button";
import { isDesktopApp } from "@/lib/is-desktop";
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
    setFailed(null);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !data?.url) throw new Error(data?.error ?? "Couldn't reach Stripe. Try again.");
      window.location.assign(data.url);
      if (isDesktopApp()) {
        setInBrowser(true);
        setPending(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach Stripe. Try again.");
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

      {checkout === "canceled" ? <Notice>Checkout canceled. Nothing was charged.</Notice> : null}
      {checkout === "error" ? <Notice>Couldn&apos;t reach Stripe to start your checkout. Try again below.</Notice> : null}
      {inBrowser ? (
        <Notice>Stripe opened in your browser. Finish there; your plan shows here when you come back.</Notice>
      ) : null}
      {checkout === "success" && plan.id !== "free" ? <Notice>You&apos;re on {plan.label}. Thanks!</Notice> : null}
      {confirming ? <Notice>Confirming your payment with Stripe…</Notice> : null}
      {checkout === "success" && plan.id === "free" && gaveUp ? (
        <Notice>Your payment is still being confirmed. Reload this page in a minute.</Notice>
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
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Plans aren&apos;t for sale on this server.</p>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
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

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-border/60 bg-accent/40 px-3 py-2 text-sm text-foreground">{children}</p>;
}
