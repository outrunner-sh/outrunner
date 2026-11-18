import { ArrowLeft } from "lucide-react";

import { SkeletonRows } from "@/components/ui/skeleton-swap";
import { PageHeader, PageLayout } from "@/components/page-layout";

/**
 * The Automations pane while its data streams in: its heading where the pane's
 * own puts it, so nothing moves when the org's own arrives, then placeholder
 * rows. The heading is generic — the org isn't known yet — but it is the same
 * line, width and height, so the pane reads as it will.
 */
export function AutomationsLoading() {
  return (
    <div role="status" aria-busy aria-label="Opening automations">
      <PageLayout className="space-y-8">
        <PageHeader title="Automations" description="Recurring and event-driven workflows for your environments." />
        <SkeletonRows rows={5} rowHeight={44} />
      </PageLayout>
    </div>
  );
}

/**
 * One automation, or a new one, while it streams in: the editor's own way back
 * and the placeholder bars its heading and the line under it would occupy —
 * the heading is the automation's name, which isn't known yet — then the form's
 * rows, in the editor's own column, so the pane doesn't jump when it arrives.
 */
export function AutomationLoading() {
  return (
    <div role="status" aria-busy aria-label="Opening the automation" className="px-8 py-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <BackToAutomations />
        <div className="space-y-2">
          <SkeletonRows rows={1} rowHeight={28} barHeight={14} className="max-w-56" />
          <SkeletonRows rows={2} rowHeight={22} className="max-w-lg" />
        </div>
        <SkeletonRows rows={4} rowHeight={48} />
      </div>
    </div>
  );
}

/**
 * A run's review session while it streams in: the same full-height pane, the
 * same bordered header and the same conversation skeleton its own SkeletonSwap
 * shows once it has the run — so opening a run is never a blank page, and what
 * lands in its place lands exactly where the placeholder was.
 */
export function RunSessionLoading() {
  return (
    <div role="status" aria-busy aria-label="Opening the run" className="flex h-full min-h-0 flex-col">
      <div className="space-y-1 border-b border-border/60 px-4 py-3">
        <BackToAutomations />
        {/* The automation that ran, what it ran on, and how it stands. */}
        <SkeletonRows rows={1} rowHeight={20} className="max-w-md" />
        <SkeletonRows rows={1} rowHeight={16} barHeight={6} className="max-w-64" />
      </div>
      <SkeletonRows rows={6} rowHeight={28} indent={16} className="px-4 pt-4" />
    </div>
  );
}

/** The way back both the editor and a run have, where they have it. */
function BackToAutomations() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <ArrowLeft className="size-3.5" /> Automations
    </span>
  );
}
