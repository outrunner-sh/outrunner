import { AlertCircle, Check, Circle, Loader2, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

export type RowState = "todo" | "working" | "done" | "problem" | "skipped";

/**
 * One line of a setup checklist: what it is, whether it's done, and the one
 * action that moves it forward. A row only ever asks for one thing at a time.
 */
export function ChecklistRow({
  state,
  title,
  detail,
  action,
  children,
}: {
  state: RowState;
  title: string;
  /** One line under the title: what's needed, or what was found. */
  detail?: React.ReactNode;
  /** The button (or buttons) on the right. */
  action?: React.ReactNode;
  /** Anything that needs more room, below the row. */
  children?: React.ReactNode;
}) {
  return (
    <div className="border-border/60 border-b px-4 py-4 last:border-b-0">
      <div className="flex items-start gap-3">
        <StateIcon state={state} />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "text-sm font-medium",
              (state === "done" || state === "skipped") && "text-muted-foreground",
            )}
          >
            {title}
          </p>
          {detail && <div className="text-muted-foreground mt-0.5 text-xs">{detail}</div>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      {children && <div className="mt-3 pl-8">{children}</div>}
    </div>
  );
}

function StateIcon({ state }: { state: RowState }) {
  const box = "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full";
  switch (state) {
    case "done":
      return (
        <span className={cn(box, "bg-success/15 text-success")} aria-label="Done">
          <Check className="size-3.5" strokeWidth={3} />
        </span>
      );
    case "working":
      return (
        <span className={cn(box, "text-muted-foreground")} aria-label="In progress">
          <Loader2 className="size-4 animate-spin" />
        </span>
      );
    case "problem":
      return (
        <span className={cn(box, "text-warning")} aria-label="Needs attention">
          <AlertCircle className="size-4" />
        </span>
      );
    case "todo":
      return (
        <span className={cn(box, "text-muted-foreground/50")} aria-label="To do">
          <Circle className="size-4" />
        </span>
      );
    case "skipped":
      return (
        <span className={cn(box, "bg-muted text-muted-foreground")} aria-label="Skipped">
          <Minus className="size-3.5" strokeWidth={3} />
        </span>
      );
  }
}

/** A shell command with a copy button, for the fixes the app can't run itself. */
export function CommandSnippet({ command }: { command: string }) {
  return (
    <div className="bg-muted/50 border-border/60 flex items-center justify-between gap-2 rounded-md border px-3 py-1.5">
      <code className="truncate font-mono text-xs">{command}</code>
      <button
        type="button"
        onClick={() => void navigator.clipboard?.writeText(command)}
        className="text-muted-foreground hover:text-foreground shrink-0 text-xs"
      >
        Copy
      </button>
    </div>
  );
}
