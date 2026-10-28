import type { Checks } from "@/lib/review/pulls";
import { cn } from "@/lib/utils";

/** A PR's checks at a glance: failing, pending, passing, or none. */
export function ChecksDot({ checks, withLabel = false }: { checks: Checks | null; withLabel?: boolean }) {
  if (!checks) return null;
  const total = checks.passing + checks.failing + checks.pending;
  const state = total === 0 ? "none" : checks.failing ? "failing" : checks.pending ? "pending" : "passing";
  const label =
    state === "none"
      ? "No checks"
      : state === "failing"
        ? `${checks.failing} of ${total} failing`
        : state === "pending"
          ? `${checks.pending} of ${total} pending`
          : `${total} passing`;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={label}>
      <span
        className={cn(
          "size-2 rounded-full",
          state === "failing" && "bg-red-500",
          state === "pending" && "bg-amber-500",
          state === "passing" && "bg-emerald-500",
          state === "none" && "bg-muted-foreground/40",
        )}
      />
      {withLabel && label}
    </span>
  );
}
