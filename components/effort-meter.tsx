"use client";

import { type Effort, EFFORT_LABELS, EFFORTS } from "@/lib/runtime/session-models";
import { cn } from "@/lib/utils";

/** What an effort is called, none being the model's own. */
export function effortName(effort: Effort | null): string {
  return effort ? EFFORT_LABELS[effort] : "Model default";
}

/** How many of the bars an effort fills: none for the model's own. */
function filled(effort: Effort | null): number {
  return effort ? EFFORTS.indexOf(effort) + 1 : 0;
}

/**
 * An effort as a row of bars, one per level, lit up to it (none lit: the
 * model's own). Decorative: whatever shows it names the effort in words.
 */
export function EffortMeter({ effort, className }: { effort: Effort | null; className?: string }) {
  const lit = filled(effort);
  return (
    <span aria-hidden className={cn("effort-meter", className)}>
      {EFFORTS.map((level, i) => (
        <span key={level} data-on={i < lit || undefined} />
      ))}
    </span>
  );
}

/**
 * The effort as bars to click: a bar sets its level, and the level already
 * set, clicked again, goes back to the model's own.
 */
export function EffortPicker({
  effort,
  onChange,
  label,
  disabled,
  levels = EFFORTS,
}: {
  effort: Effort | null;
  onChange: (effort: Effort | null) => void;
  /** Whose effort, for screen readers: "Opus effort". */
  label: string;
  disabled?: boolean;
  levels?: readonly Effort[];
}) {
  const lit = filled(effort);
  return (
    <span role="group" aria-label={label} title={`Effort: ${effortName(effort)}`} className="effort-meter effort-picker">
      {levels.map((level, i) => (
        <button
          key={level}
          type="button"
          disabled={disabled}
          aria-pressed={level === effort}
          aria-label={level === effort ? `${EFFORT_LABELS[level]} (set; click for the model default)` : EFFORT_LABELS[level]}
          data-on={i < lit || undefined}
          onClick={() => onChange(level === effort ? null : level)}
        />
      ))}
    </span>
  );
}
