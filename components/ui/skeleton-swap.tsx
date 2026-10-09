"use client";

import { useSkeletonSwap } from "@/hooks/use-skeleton-swap";
import { cn } from "@/lib/utils";

/**
 * Content that loads, after interior.dev's Skeleton Swap: the skeleton and the
 * content share one grid cell and crossfade, so nothing around them moves.
 * A quick load shows no skeleton (the content just fades in), and a shown one
 * is held long enough not to blink (useSkeletonSwap).
 */
export function SkeletonSwap({
  ready,
  skeleton,
  label,
  className,
  children,
}: {
  /** True once the content is complete. */
  ready: boolean;
  /** Bars shaped like the content, at its row heights (SkeletonRows). */
  skeleton: React.ReactNode;
  /** Names the region for screen readers, announced once loaded. */
  label?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const showSkeleton = useSkeletonSwap(ready);
  const showContent = ready && !showSkeleton;
  return (
    <div aria-busy={!ready || undefined} aria-label={label} className={cn("skeleton-swap", className)}>
      {/* Hidden means unreachable too, not only invisible: no focus, no
          clicks, nothing read aloud until it is shown. */}
      <div
        inert={!showContent}
        aria-hidden={!showContent || undefined}
        className={cn("skeleton-swap-content", !showContent && "is-hidden")}
      >
        {children}
      </div>
      {showSkeleton && (
        <div aria-hidden className="skeleton-swap-skeleton">
          {skeleton}
        </div>
      )}
      {label && (
        <span role="status" className="sr-only">
          {ready ? `${label} loaded` : ""}
        </span>
      )}
    </div>
  );
}

/** Placeholder rows: one bar per row, at the row's own height, with widths
 *  that vary like real text and a short last line. */
export function SkeletonRows({
  rows,
  rowHeight,
  barHeight = 8,
  indent = 0,
  className,
}: {
  rows: number;
  rowHeight: number;
  barHeight?: number;
  /** Left inset of each bar, in px, to line up with the content's text. */
  indent?: number;
  className?: string;
}) {
  return (
    <div className={className}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center" style={{ height: rowHeight, paddingLeft: indent }}>
          <div
            className="skeleton-bar"
            style={{ height: barHeight, width: `${rows > 1 && i === rows - 1 ? 58 : BAR_WIDTHS[(i * 7 + 3) % BAR_WIDTHS.length]}%` }}
          />
        </div>
      ))}
    </div>
  );
}

const BAR_WIDTHS = [92, 78, 86, 70, 82, 74] as const;
