import { cn } from "@/lib/utils";

/*
 * Onboarding's dashed frames: its cards and panels sit in one, drawn in SVG
 * for longer dashes than `border-dashed` gives.
 */

/** The frame itself, over its card or panel. Brightens on a card's hover. */
function DashedFrame() {
  return (
    <svg
      aria-hidden
      // m-0: never spaced as a child of a `space-y` panel.
      className="text-border group-hover:text-foreground/40 pointer-events-none absolute inset-0 m-0 size-full overflow-visible transition-colors"
    >
      <rect width="100%" height="100%" rx="12" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="8 6" />
    </svg>
  );
}

/** A rule across a panel, its dashes as the frame's. */
export function DashedRule() {
  return (
    <svg aria-hidden className="text-border block h-px w-full overflow-visible">
      <line x1="0" y1="0.5" x2="100%" y2="0.5" stroke="currentColor" strokeWidth="1" strokeDasharray="8 6" />
    </svg>
  );
}

/** A choice that goes on to its page, as a card in a dashed frame. */
export function DashedCard({ className, onClick, children }: { className?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("hover:bg-accent/20 group relative w-full rounded-xl text-left transition-colors", className)}
    >
      <DashedFrame />
      {children}
    </button>
  );
}

/** What sits in a frame without being a choice: a form, a list. */
export function DashedPanel({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("relative rounded-xl", className)}>
      <DashedFrame />
      {children}
    </div>
  );
}
