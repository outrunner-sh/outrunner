import { Hash, type LucideIcon, Terminal, Webhook } from "lucide-react";

import { SOURCE_LABELS, type WorkItemSource, type WorkItemStatus } from "@/lib/triage/work-items";
import { cn } from "@/lib/utils";

/** Each status's colour, for its glyph. */
const COLORS: Record<WorkItemStatus, string> = {
  triage: "text-orange-500",
  todo: "text-muted-foreground",
  in_progress: "text-amber-500",
  done: "text-indigo-500 dark:text-indigo-400",
  declined: "text-muted-foreground",
  duplicate: "text-muted-foreground",
};

/**
 * A status as a small circle glyph: arrows on orange for triage, an empty
 * ring for todo, a half-filled one in progress, a check when done, a cross
 * when declined or a duplicate.
 */
export function StatusIcon({ status, className }: { status: WorkItemStatus; className?: string }) {
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      className={cn("size-3.5 shrink-0", COLORS[status], className)}
      fill="none"
      stroke="currentColor"
    >
      {status === "triage" && (
        <>
          <circle cx="7" cy="7" r="6.5" fill="currentColor" stroke="none" />
          <path
            d="M4 5.5h5.5M8 4l1.5 1.5L8 7M10 8.5H4.5M6 7L4.5 8.5 6 10"
            stroke="var(--background)"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {status === "todo" && <circle cx="7" cy="7" r="5.75" strokeWidth="1.5" />}
      {status === "in_progress" && (
        <>
          <circle cx="7" cy="7" r="5.75" strokeWidth="1.5" />
          <path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" stroke="none" />
        </>
      )}
      {status === "done" && (
        <>
          <circle cx="7" cy="7" r="6.5" fill="currentColor" stroke="none" />
          <path
            d="M4.5 7.2l1.7 1.7 3.4-3.6"
            stroke="var(--background)"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {(status === "declined" || status === "duplicate") && (
        <>
          <circle cx="7" cy="7" r="6.5" fill="currentColor" stroke="none" />
          <path d="M5 5l4 4M9 5l-4 4" stroke="var(--background)" strokeWidth="1.4" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

const SOURCE_ICONS: Record<WorkItemSource, LucideIcon | null> = {
  app: null,
  slack: Hash,
  cli: Terminal,
  api: Webhook,
};

/** Where an item came from, as an icon: none for one made in the app. */
export function SourceIcon({ source, className }: { source: WorkItemSource; className?: string }) {
  const Icon = SOURCE_ICONS[source];
  return Icon ? <Icon aria-label={`From ${SOURCE_LABELS[source]}`} className={cn("size-3.5 shrink-0", className)} /> : null;
}
