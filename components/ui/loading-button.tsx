"use client";

import { CircleAlert, Check } from "lucide-react";

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
   *  "Try again" (the next action, not the diagnosis). */
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
    { key: "error", text: labels.error ?? "Try again", icon: <CircleAlert /> },
  ];
  const pending = status === "pending";
  const current = faces.find((face) => face.key === status) ?? faces[0];
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
          {faces.map((face) => (
            <span key={face.key} className={cn("loading-button-face", face.key === status && "is-current")}>
              {face.icon}
              {face.text}
              {face.key === "idle" && trailingIcon}
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
