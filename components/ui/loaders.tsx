import { cn } from "@/lib/utils";

/**
 * Waiting, drawn the way interior.dev draws it: a dot matrix of soft squares
 * with an accent wave crossing it diagonally. Decorative — the words beside it
 * say what is happening, so with reduced motion it holds still (one lit cell)
 * and nothing is lost.
 */
export function DotMatrix({
  rows = 5,
  cols = 7,
  cell = 4,
  gap = 2,
  className,
}: {
  rows?: number;
  cols?: number;
  /** Square size and the gap between squares, in px. */
  cell?: number;
  gap?: number;
  className?: string;
}) {
  const span = rows + cols - 2 || 1;
  return (
    <span
      aria-hidden
      className={cn("dot-matrix", className)}
      style={{
        gridTemplateRows: `repeat(${rows}, ${cell}px)`,
        gridTemplateColumns: `repeat(${cols}, ${cell}px)`,
        gap,
      }}
    >
      {Array.from({ length: rows * cols }, (_, i) => {
        const row = Math.floor(i / cols);
        const col = i % cols;
        // Delay by the cell's diagonal, so the lit band sweeps corner to corner.
        const step = (row + col) / span;
        return (
          <span
            key={i}
            className={cn("dot-matrix-cell", row === rows >> 1 && col === cols >> 1 && "is-still")}
            style={{ animationDelay: `${(step * 0.9).toFixed(3)}s` }}
          />
        );
      })}
    </span>
  );
}

/** The compact animated mark for a model that is thinking. Shared by the
 * conversation and session lists so a working session has one visual language
 * everywhere. */
export function ThinkingIcon({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
    >
      <DotMatrix rows={3} cols={3} cell={3} gap={1.5} />
    </span>
  );
}

/** A thin arc on a faint track: the in-progress mark for a row or a button.
 *  Inherits the text colour and sizes to the text (1em) unless told. */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("spinner size-[1em] shrink-0", className)}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.6" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
