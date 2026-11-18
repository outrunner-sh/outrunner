import type { AllowanceView } from "@/lib/openrouter/allowance";
import { cn } from "@/lib/utils";

/** How much of their allowance on Outrunner's models the user has used, as a
 *  labelled bar: the sidebar's (compact), and Settings → Usage's. Amber for a
 *  limit reached or near — it says what to do next, not that something failed. */
export function AllowanceBar({
  view,
  label = "Outrunner's models",
  compact = false,
}: {
  view: AllowanceView;
  label?: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "space-y-1" : "space-y-1.5"}>
      <div className={cn("flex items-baseline justify-between gap-2", compact ? "text-[11px]" : "text-xs")}>
        <span className="truncate text-muted-foreground">{label}</span>
        <span className={cn("shrink-0 tabular-nums", view.state === "out" ? "text-warning" : "text-muted-foreground")}>
          {view.label}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(view.percent)}
        aria-valuetext={view.label}
        className={cn("overflow-hidden rounded-full bg-muted", compact ? "h-1" : "h-1.5")}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            view.state === "ok" ? "bg-foreground/70" : "bg-warning",
          )}
          style={{ width: `${view.percent}%` }}
        />
      </div>
    </div>
  );
}
