import Link from "next/link";

import { RaillessSidebarButtons } from "@/components/app-frame";
import { DotMatrix } from "@/components/ui/loaders";

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

export function RouteMessage({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  /** Defaults to a way home. */
  action?: React.ReactNode;
}) {
  return (
    <div className="route-state">
      <RaillessSidebarButtons />
      <DotMatrix rows={6} cols={10} className="is-still" />
      <div className="space-y-1.5 text-center">
        <h1 className="route-state-title">{title}</h1>
        <p className="route-state-detail">{detail}</p>
      </div>
      <div className="flex items-center gap-2">
        {action ?? <HomeLink />}
      </div>
    </div>
  );
}

export function HomeLink() {
  return (
    <Link href="/" className="route-state-button">
      Back to home
    </Link>
  );
}
