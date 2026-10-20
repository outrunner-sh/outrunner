import Link from "next/link";

import { NoticeActions, type NoticeAction } from "@/components/ui/notice";
import { DotMatrix } from "@/components/ui/loaders";
import { cn } from "@/lib/utils";

/**
 * Full-page states for the app's routes: loading, missing and failed. Inside
 * the app layout, so the sidebar stays and there is always a way on — the Mac
 * app has no browser back button to fall back on.
 */
export function RouteLoading({ label }: { label: string }) {
  return (
    <div role="status" className="route-state">
      <DotMatrix rows={6} cols={10} />
      <p className="route-state-title">{label}</p>
    </div>
  );
}

/**
 * A state that takes the whole page or panel: a route that failed or is
 * missing, a session that didn't start. `actions` are the ways on (defaults to
 * a way home); `footer` sits under them, for a fact shown from the start.
 * `message` is what an action came back with: it hangs under the actions
 * without taking space, so the centered page doesn't jump when it appears.
 */
export function RouteMessage({
  title,
  detail,
  actions,
  footer,
  message,
  className,
}: {
  title: string;
  detail: React.ReactNode;
  actions?: NoticeAction[];
  footer?: React.ReactNode;
  message?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("route-state", className)}>
      <DotMatrix rows={6} cols={10} className="is-still" />
      <div className="space-y-1.5 text-center">
        <h1 className="route-state-title">{title}</h1>
        <p className="route-state-detail">{detail}</p>
      </div>
      <div className="route-state-action-row">
        {actions ? <NoticeActions actions={actions} className="route-state-actions" /> : <HomeLink />}
        {message && <div className="route-state-message">{message}</div>}
      </div>
      {footer}
    </div>
  );
}

export const HOME_ACTION: NoticeAction = { label: "Back to home", href: "/" };

export function HomeLink() {
  return (
    <Link href="/" className="route-state-button">
      Back to home
    </Link>
  );
}
