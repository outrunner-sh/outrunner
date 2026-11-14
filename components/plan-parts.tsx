import type { Plan } from "@/lib/billing/plans";
import { formatUsd } from "@/lib/billing/usage";
import { boxSize } from "@/lib/runtime/box-sizes";

/** What a plan includes. The model allowance is never shown in dollars. */
export function PlanIncludes({ plan }: { plan: Plan }) {
  const included = formatUsd(plan.usage.includedUsd * 100);
  return (
    <ul className="space-y-1 text-xs text-muted-foreground">
      <li>
        {plan.usage.per === "once"
          ? `${included} of cloud usage to start`
          : `${included} of cloud usage included every month${plan.usage.overage ? ", then billed by the minute at 1.5x" : ""}`}
      </li>
      <li>
        {plan.concurrentCloudSessions} cloud sessions at once, up to {boxSize(plan.largestBoxSize).label} boxes
      </li>
      <li>
        {plan.models.usd === null
          ? "Outrunner's models, unlimited usage"
          : plan.models.per === "once"
            ? "Outrunner's models, to try"
            : "Outrunner's models, usage included"}
      </li>
    </ul>
  );
}

/** "$20 / month", with the interval set small. */
export function PlanPrice({ usd }: { usd: number }) {
  return (
    <p className="text-sm text-foreground">
      ${usd}
      <span className="text-xs text-muted-foreground"> / month</span>
    </p>
  );
}
