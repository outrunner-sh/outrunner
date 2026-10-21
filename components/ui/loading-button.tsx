"use client";

import { Check, RotateCw } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/loaders";
import { cn } from "@/lib/utils";

export type ActionStatus = "idle" | "pending" | "success" | "error";

/**
 * A button whose label follows its action, after interior.dev's Loading
 * Button. Every label is laid out in the same cell from the start, so the
 * button is as wide as its widest label and never jumps as the label changes.
 * Busy is not disabled: while pending, clicks are ignored but the button stays
 * focused and reachable; only `disabled` (genuinely unavailable) disables it.
 */
export function LoadingButton({
  status,
  labels,
  icon,
  trailingIcon,
  type = "button",
  onClick,
  disabled,
  size = "sm",
  variant = "default",
  className,
}: {
  status: ActionStatus;
  /** `idle` is also the accessible name; the rest default to it, "Done" and
   *  the idle label again. While it works a button keeps its idle label and
   *  turns its icon: a `pending` label is for a wait that is a different step
   *  than the click (Opening GitHub), not the same verb said again
   *  (Publishing). A failed button keeps its label rather than turning
   *  red: the caller shows the reason beside it (InlineMessage). */
  labels: { idle: string; pending?: string; success?: string; error?: string };
  /** Shown beside the idle label. */
  icon?: React.ReactNode;
  /** Shown after the idle label: an arrow, say. */
  trailingIcon?: React.ReactNode;
  type?: "button" | "submit";
  onClick?: () => void;
  disabled?: boolean;
  size?: "sm" | "default";
  variant?: "default" | "outline";
  className?: string;
}) {
  const faces: { key: ActionStatus; text: string; icon: React.ReactNode }[] = [
    { key: "idle", text: labels.idle, icon },
    { key: "pending", text: labels.pending ?? labels.idle, icon: <Spinner /> },
    { key: "success", text: labels.success ?? "Done", icon: <Check /> },
    { key: "error", text: labels.error ?? labels.idle, icon: icon ?? <RotateCw /> },
  ];
  const pending = status === "pending";
  // A failure that reads exactly like idle shows the idle face itself: two
  // identical faces crossfading would blur the label for nothing.
  const face: ActionStatus = status === "error" && labels.error === undefined && icon !== undefined ? "idle" : status;
  const current = faces.find((f) => f.key === face) ?? faces[0];
  return (
    <>
      <button
        type={type}
        disabled={disabled}
        aria-busy={pending || undefined}
        aria-disabled={pending || undefined}
        aria-label={current.text}
        onClick={(event) => {
          if (pending) {
            event.preventDefault();
            return;
          }
          onClick?.();
        }}
        className={cn(buttonVariants({ size, variant }), "loading-button", `is-${status}`, className)}
      >
        <span aria-hidden className="loading-button-faces">
          {faces.map((f) => (
            <span key={f.key} className={cn("loading-button-face", f.key === face && "is-current")}>
              {f.icon}
              {f.text}
              {f.key === "idle" && trailingIcon}
            </span>
          ))}
        </span>
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {status === "success" ? current.text : status === "error" ? current.text : ""}
      </span>
    </>
  );
}
