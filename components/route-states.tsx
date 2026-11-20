import Link from "next/link";

import { RaillessSidebarButtons } from "@/components/app-frame";
import { NoticeActions, type NoticeAction } from "@/components/ui/notice";
import { DotMatrix } from "@/components/ui/loaders";
import { cn } from "@/lib/utils";

/**
 * Full-page states for the app's routes: loading, missing and failed. Inside
 * the app layout, so the sidebar stays and there is always a way on — the Mac
 * app has no browser back button to fall back on. On a session's path, where
 * the collapsed sidebar's rail steps aside for a header these states don't
 * have, they carry its buttons themselves.
 */
export function RouteLoading({ label }: { label: string }) {
  return (
    <div role="status" className="route-state">
      <RaillessSidebarButtons />
      <DotMatrix rows={6} cols={10} />
      <p className="route-state-title">{label}</p>
    </div>
  );
}

/**
 * A session's page before it has the session: its frame — the header, the
 * chat column with its composer's box, the environment column — and nothing
 * in it. No loader: what fills it lands where this already stands, on a page
 * load before the app has started, and on the rare open of a session the
 * sidebar doesn't have yet, so the page never flashes a spinner first.
 */
export function SessionLoading() {
  return (
    <div role="status" aria-busy aria-label="Opening session" className="studio-shell">
      <header className="studio-header">
        <RaillessSidebarButtons />
      </header>
      <section className="studio-chat">
        <div className="flex min-h-0 flex-col justify-end">
          {/* The composer's box, as tall as an empty one. */}
          <div aria-hidden className="studio-composer h-[105px]" />
        </div>
      </section>
      <aside aria-hidden className="studio-inspector studio-env" />
    </div>
  );
}

/**
 * A state that takes the whole page or panel: a route that failed or is
 * missing, a session that didn't start. `actions` are the ways on (defaults to
 * a way home); `footer` sits under them, for a fact shown from the start.
 * `message` is what an action came back with: it hangs below the actions (and
 * the footer, when there is one) without taking space, so the centered page
 * doesn't jump when it appears.
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
      <RaillessSidebarButtons />
      <DotMatrix rows={6} cols={10} className="is-still" />
      <div className="space-y-1.5 text-center">
        <h1 className="route-state-title">{title}</h1>
        <p className="route-state-detail">{detail}</p>
      </div>
      <div className="route-state-action-row">
        {actions ? <NoticeActions actions={actions} className="route-state-actions" /> : <HomeLink />}
        {footer}
        {message && <div className="route-state-message">{message}</div>}
      </div>
    </div>
  );
}

export const HOME_ACTION: NoticeAction = { label: "Back to home", href: "/" };

function HomeLink() {
  return (
    <Link href="/" className="route-state-button">
      Back to home
    </Link>
  );
}
