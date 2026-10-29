import { ArrowLeft } from "lucide-react";

import { SkeletonRows } from "@/components/ui/skeleton-swap";

/**
 * The Automations pane while its data streams in: its heading where the pane's
 * own puts it, so nothing moves when the org's own arrives, then placeholder
 * rows. The heading is generic — the org isn't known yet — but it is the same
 * line, width and height, so the pane reads as it will.
 */
export function AutomationsLoading() {
  return (
    <div className="flex h-full flex-col px-8 py-8" aria-busy>
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-6">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">Automations</h1>
          <p className="text-[13px] text-muted-foreground">
            Shared workflows for your org: a session that starts on its own, like a code review on every pull request.
          </p>
        </header>
        <SkeletonRows rows={5} rowHeight={44} />
      </div>
    </div>
  );
}

/**
 * One automation (or a new one) while it streams in: the way back to the list
 * and placeholder rows where the editor goes, in the editor's own column, so
 * the pane doesn't jump when it arrives.
 */
export function AutomationLoading() {
  return (
    <div className="px-8 py-8" aria-busy>
      <div className="mx-auto max-w-3xl space-y-6">
        <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <ArrowLeft className="size-3.5" /> Automations
        </span>
        <SkeletonRows rows={5} rowHeight={48} />
      </div>
    </div>
  );
}

/**
 * A run's review session while it streams in: placeholder rows in the pane's
 * own column, so opening a run is never a blank page. No heading or back link:
 * both are the review session's own to say, and saying them wrong for a moment
 * is worse than saying nothing.
 */
export function RunSessionLoading() {
  return (
    <div className="px-8 py-8" aria-busy>
      <div className="mx-auto max-w-4xl space-y-6">
        <SkeletonRows rows={6} rowHeight={44} />
      </div>
    </div>
  );
}
