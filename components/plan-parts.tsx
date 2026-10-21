import { type BillingInterval, LOOKUP_KEYS, type Plan } from "@/lib/billing/plans";
import { boxSize } from "@/lib/runtime/box-sizes";
import { cn } from "@/lib/utils";

/** What a plan includes. The model allowance is never shown in dollars. */
export function PlanIncludes({ plan }: { plan: Plan }) {
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

/** Monthly or yearly, for the plans on sale. */
export function BillingIntervalToggle({
  interval,
  onChange,
}: {
  interval: BillingInterval;
  onChange: (interval: BillingInterval) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Billing interval" className="inline-flex rounded-md border border-border/60 p-0.5">
      {(["month", "year"] as const).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={interval === option}
          onClick={() => onChange(option)}
          className={cn(
            "rounded px-3 py-1 text-sm transition-colors",
            interval === option ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option === "month" ? "Monthly" : "Yearly · 2 months free"}
        </button>
      ))}
    </div>
  );
}

/** A plan's price for the interval, in USD; undefined where Stripe gave none. */
export function planPrice(
  prices: Record<string, number>,
  plan: keyof typeof LOOKUP_KEYS,
  interval: BillingInterval,
): number | undefined {
  return prices[LOOKUP_KEYS[plan][interval]];
}

/** "$20 / month", with the interval set small. */
export function PlanPrice({ usd, interval }: { usd: number; interval: BillingInterval }) {
  return (
    <p className="text-sm text-foreground">
      ${usd}
      <span className="text-xs text-muted-foreground"> / {interval === "month" ? "month" : "year"}</span>
    </p>
  );
}
