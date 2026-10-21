"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight, KeyRound, Loader2 } from "lucide-react";

import { AgentIcon } from "@/components/brand-icons";
import { BillingIntervalToggle, PlanIncludes, PlanPrice, planPrice } from "@/components/plan-parts";
import { Button } from "@/components/ui/button";
import { type BillingInterval, type Plan, PLANS } from "@/lib/billing/plans";
import type { CloudNext } from "@/lib/onboarding/types";
import { cn } from "@/lib/utils";

/** Which way out is under way, so its button spins. */
export type PlansLeaving = "home" | "providers" | "pro" | "max";

/**
 * The last step: Outrunner's plans, free to start with, and the way to the
 * user's own models instead (their own key, or the Claude Code or Codex
 * subscription they already pay for) in Settings → Providers. Where plans
 * aren't sold, only the way on and the providers.
 */
export function PlansStep({
  prices,
  leaving,
  onBack,
  onLeave,
}: {
  /** Plan prices in USD by Stripe lookup key; null where plans aren't sold. */
  prices: Record<string, number> | null;
  leaving: PlansLeaving | null;
  onBack: () => void;
  onLeave: (next: CloudNext) => void;
}) {
  const [interval, setBillingInterval] = useState<BillingInterval>("month");
  const busy = leaving !== null;
  const spin = (on: boolean) => (on ? <Loader2 className="size-4 animate-spin" /> : null);

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{prices ? "Start free" : "You're all set"}</h1>
        <p className="text-muted-foreground text-sm">
          {prices
            ? "Every account starts on Free. Upgrade now or whenever you need more, in Settings → Billing."
            : "Sessions run on Outrunner's models to start with. You can bring your own any time."}
        </p>
      </div>

      {prices && (
        <div className="space-y-3">
          <BillingIntervalToggle interval={interval} onChange={setBillingInterval} />
          <div className="grid gap-3 sm:grid-cols-3">
            <PlanCard plan={PLANS.free} price={<p className="text-sm">$0</p>} highlighted>
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                onClick={() => onLeave({ to: "home" })}
                disabled={busy}
              >
                {spin(leaving === "home")}
                Continue free
              </Button>
            </PlanCard>
            {(["pro", "max"] as const).map((id) => {
              const price = planPrice(prices, id, interval);
              return (
                <PlanCard
                  key={id}
                  plan={PLANS[id]}
                  price={price !== undefined ? <PlanPrice usd={price} interval={interval} /> : null}
                >
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground self-start px-0 hover:bg-transparent"
                    onClick={() => onLeave({ to: "plan", plan: id, interval })}
                    disabled={busy || price === undefined}
                  >
                    {spin(leaving === id)}
                    Upgrade to {PLANS[id].label} <ArrowRight className="size-3.5" />
                  </Button>
                </PlanCard>
              );
            })}
          </div>
        </div>
      )}

      <div className="border-border/60 flex items-center gap-3 rounded-xl border px-4 py-3">
        <span className="text-muted-foreground flex shrink-0 items-center gap-1.5">
          <AgentIcon agent="claude" className="size-4" />
          <AgentIcon agent="codex" className="size-4" />
          <KeyRound className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Use your own models</p>
          <p className="text-muted-foreground text-xs">
            Connect your Claude Code or Codex subscription, or bring your own API key.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => onLeave({ to: "providers" })}
          disabled={busy}
        >
          {spin(leaving === "providers")}
          Connect
        </Button>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeft className="size-4" /> Back
        </Button>
        {!prices && (
          <Button onClick={() => onLeave({ to: "home" })} disabled={busy}>
            {spin(leaving === "home")}
            Continue <ArrowRight className="size-4" />
          </Button>
        )}
      </div>
    </section>
  );
}

/** A plan, what it includes, and its button at the foot. */
function PlanCard({
  plan,
  price,
  highlighted,
  children,
}: {
  plan: Plan;
  price: React.ReactNode;
  highlighted?: boolean;
  /** The button. */
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "border-border/60 flex flex-col justify-between gap-4 rounded-xl border p-4",
        highlighted && "border-amber-500/50",
      )}
    >
      <div className="space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm font-medium">{plan.label}</p>
          {price}
        </div>
        <PlanIncludes plan={plan} />
      </div>
      {children}
    </div>
  );
}
