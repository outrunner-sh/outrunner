"use client";

import { CircleAlert, Info, Loader2, TriangleAlert } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * How serious a message is. `progress` is something under way (a retry), not
 * a failure; `warning` is a stop the user can recover from with nothing lost;
 * `error` is something that did not happen. Red is kept for `error` alone, so
 * a wait or a limit never looks like a failure.
 */
export type NoticeTone = "progress" | "info" | "warning" | "error";

/** One button or link a message offers. The first `primary` one is the way on. */
export type NoticeAction = {
  label: string;
  onClick?: () => void;
  /** A link instead of a button. */
  href?: string;
  /** `href` leaves Outrunner (GitHub, Stripe): opens in a new tab. */
  external?: boolean;
  icon?: React.ReactNode;
  primary?: boolean;
  disabled?: boolean;
};

const ICONS: Record<NoticeTone, React.ReactNode> = {
  progress: <Loader2 className="animate-spin" />,
  info: <Info />,
  warning: <TriangleAlert />,
  error: <CircleAlert />,
};

export function NoticeActions({ actions, className }: { actions?: NoticeAction[]; className?: string }) {
  if (!actions?.length) return null;
  return (
    <div className={cn("notice-actions", className)}>
      {actions.map((action) => {
        const content = (
          <>
            {action.icon}
            {action.label}
          </>
        );
        const cls = cn("notice-action", action.primary && "is-primary");
        if (action.href && action.external) {
          return (
            <a key={action.label} href={action.href} target="_blank" rel="noreferrer" className={cls} onClick={action.onClick}>
              {content}
            </a>
          );
        }
        return action.href ? (
          <Link key={action.label} href={action.href} className={cls} onClick={action.onClick}>
            {content}
          </Link>
        ) : (
          <button key={action.label} type="button" className={cls} onClick={action.onClick} disabled={action.disabled}>
            {content}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A banner for the state of something larger than one field: a session's
 * connection, its box, its agent. Title says what happened, detail what it
 * means for the user's work, meta a fact to read at a glance (attempts, time).
 */
export function Notice({
  tone,
  title,
  detail,
  meta,
  actions,
  className,
}: {
  tone: NoticeTone;
  title: React.ReactNode;
  detail?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: NoticeAction[];
  className?: string;
}) {
  return (
    <div className={cn("notice", `is-${tone}`, className)} role={tone === "progress" || tone === "info" ? "status" : "alert"}>
      <span className="notice-icon" aria-hidden>
        {ICONS[tone]}
      </span>
      <div className="notice-text">
        <strong>{title}</strong>
        {detail && <span>{detail}</span>}
        {meta && <span className="notice-meta">{meta}</span>}
      </div>
      <NoticeActions actions={actions} />
    </div>
  );
}

/**
 * The reason beside the thing it is about: under a field, a message, a button.
 * `details` folds away a raw message (git's, a provider's) for anyone who wants it.
 */
export function InlineMessage({
  tone = "error",
  children,
  actions,
  details,
  className,
}: {
  tone?: Exclude<NoticeTone, "progress">;
  children: React.ReactNode;
  actions?: NoticeAction[];
  details?: string | null;
  className?: string;
}) {
  return (
    <div className={cn("inline-message", `is-${tone}`, className)} role={tone === "error" ? "alert" : "status"}>
      <div className="inline-message-row">
        <span className="notice-icon" aria-hidden>
          {ICONS[tone]}
        </span>
        <div className="inline-message-body">
          <span className="inline-message-text">{children}</span>
          <NoticeActions actions={actions} className="is-inline" />
        </div>
      </div>
      {details && (
        <details className="inline-message-details">
          <summary>Details</summary>
          <pre>{details}</pre>
        </details>
      )}
    </div>
  );
}
