"use client";

import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

import { Notice } from "@/components/ui/notice";
import type { GitHubConnectionNotice } from "@/lib/github/connection-notice";

/** Dismissed for this browser tab's visit: it asks again next time. */
const DISMISSED_KEY = "outrunner:github-notice-dismissed";

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
const dismissedNotice = () => sessionStorage.getItem(DISMISSED_KEY);

/**
 * Asks the user, anywhere in the app, to connect GitHub in Settings →
 * Connections: their sessions still run on an old sign-in token, which
 * reaches every repository they can (`legacy`), or GitHub stopped renewing
 * their connection (`broken`). Not on Connections itself, which says it in
 * place; dismissed until the next visit.
 */
export function GitHubConnectionNoticeBanner({ notice }: { notice: GitHubConnectionNotice }) {
  const pathname = usePathname();
  // Taken as dismissed on the server, so it never flashes before hydrating.
  const dismissed = useSyncExternalStore(subscribe, dismissedNotice, () => notice) === notice;
  if (!notice || dismissed || pathname.startsWith("/settings/connections")) return null;
  const dismiss = () => {
    sessionStorage.setItem(DISMISSED_KEY, notice);
    for (const listener of listeners) listener();
  };
  return (
    <Notice
      className="fixed right-4 bottom-4 z-40 w-[min(420px,calc(100vw-32px))] shadow-lg"
      tone="warning"
      title={notice === "broken" ? "Reconnect GitHub" : "Choose which repositories Outrunner reaches"}
      detail={
        notice === "broken"
          ? "GitHub stopped renewing Outrunner's access to your repositories. Reconnect it in Settings → Connections; nothing else changes."
          : "Your sessions still use an old GitHub token from signing in, which reaches every repository you can. Connect GitHub in Settings → Connections to pick the ones Outrunner reaches."
      }
      actions={[
        { label: notice === "broken" ? "Reconnect" : "Connect GitHub", href: "/settings/connections", primary: true, onClick: dismiss },
        { label: "Not now", onClick: dismiss },
      ]}
    />
  );
}
