"use client";

import { useState } from "react";

import { isDesktopApp } from "@/lib/is-desktop";

/**
 * A link that connects (or reconnects) the user's own GitHub for their
 * repositories (app/api/github/user/connect), coming back to `next`.
 *
 * In a browser it's a plain link: the route goes to GitHub and back. In the
 * desktop shell GitHub opens in the system browser, so the code has to come
 * back through the shell's loopback listener to this webview, where the
 * connect's cookie is: the route is asked for GitHub's address (setting the
 * cookie here) and the page goes there, which the shell opens outside.
 */
export function GitHubConnectLink({
  next = "/settings/connections",
  chooseAccount = false,
  className,
  children,
}: {
  next?: "/settings/connections" | "/onboarding";
  /** Let them pick another account than the one signed in to GitHub. */
  chooseAccount?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const href = `/api/github/user/connect?next=${encodeURIComponent(next)}${chooseAccount ? "&account=choose" : ""}`;

  async function openInDesktop(event: React.MouseEvent<HTMLAnchorElement>) {
    if (!isDesktopApp()) return;
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${href}&desktop=1&format=json`, { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as { url?: string } | null;
      if (!data?.url) throw new Error();
      // GitHub's page opens in the system browser; a failure's lands here.
      window.location.assign(data.url);
      // The shell takes it from here (its loopback listener).
      setTimeout(() => setBusy(false), 5_000);
    } catch {
      setError("Couldn't open GitHub. Try again.");
      setBusy(false);
    }
  }

  return (
    <>
      <a href={href} onClick={(event) => void openInDesktop(event)} aria-busy={busy || undefined} className={className}>
        {children}
      </a>
      {error && (
        <span role="alert" className="text-destructive text-xs">
          {error}
        </span>
      )}
    </>
  );
}
