"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/** How long to hold. Long enough to be deliberate, short enough not to nag. */
export const HOLD_MS = 900;

/** "Delete session" as "delete session", but "Replace URL" as "replace
 *  URL": only its first letter, so a name in it keeps its case. */
function lowerFirst(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * A destructive action you hold rather than click, after interior.dev's Hold to
 * Confirm: a fill crosses the button while it is held, and letting go before
 * it ends cancels — a moment to change your mind, without a second dialog.
 * Works by pointer and by keyboard (hold Space or Enter). The fill is the
 * progress itself, so it shows under reduced motion too.
 */
export function HoldToConfirm({
  label,
  onConfirm,
  disabled,
  className,
}: {
  /** What it does, e.g. "Delete session"; shown as "Hold to …". */
  label: string;
  onConfirm: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const release = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  const press = () => {
    if (disabled || timer.current) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      onConfirm();
    }, HOLD_MS);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={`Hold to ${lowerFirst(label)}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        press();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onKeyDown={(event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
          event.preventDefault();
          press();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") release();
      }}
      onBlur={release}
      // A click alone does nothing: the hold is the confirmation.
      onClick={(event) => event.preventDefault()}
      className={cn("hold-to-confirm", holding && "is-holding", className)}
      style={{ "--hold-ms": `${HOLD_MS}ms` } as React.CSSProperties}
    >
      <span aria-hidden className="hold-to-confirm-fill" />
      <span className="relative">Hold to {lowerFirst(label)}</span>
    </button>
  );
}
