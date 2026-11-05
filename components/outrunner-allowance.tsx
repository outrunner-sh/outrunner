"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { AllowanceBar } from "@/components/allowance-bar";
import { NoticeActions } from "@/components/ui/notice";
import type { AllowanceView } from "@/lib/openrouter/allowance";
import { providerSettingsHref } from "@/lib/settings-links";

/**
 * How much of their allowance on Outrunner's models the user has used, as a
 * bar above their account in the sidebar; once it's spent, what
 * to do next (Connect Claude, unless it already is). Nothing where the server has no per-user allowance (one shared
 * key). Re-read on each page and when the window comes back, as sessions
 * spend it.
 */
export function OutrunnerAllowance() {
  const pathname = usePathname();
  const [view, setView] = useState<AllowanceView | null>(null);
  // Whether their own Claude is connected, asked only once the allowance is
  // spent: then sessions on Claude keep working, and Connect Claude is moot.
  const [claude, setClaude] = useState<boolean | null>(null);
  const out = view?.state === "out";

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const res = await fetch("/api/outrunner-models/usage", { cache: "no-store" });
        if (!res.ok) return; // keep what's shown; the next read may work
        const data = (await res.json()) as { allowance: AllowanceView | null };
        if (!cancelled) setView(data.allowance);
      } catch {
        // Offline or a proxy's page: keep what's shown.
      }
    };
    void read();
    window.addEventListener("focus", read);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", read);
    };
  }, [pathname]);

  useEffect(() => {
    if (!out) return;
    let cancelled = false;
    const read = async () => {
      try {
        const res = await fetch("/api/settings/claude", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { connected?: boolean };
        if (!cancelled) setClaude(Boolean(data.connected));
      } catch {
        // Offline: no button until it's known.
      }
    };
    void read();
    window.addEventListener("focus", read);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", read);
    };
  }, [out, pathname]);

  if (!view) return null;
  return (
    <div className="space-y-1.5 px-2 pb-3">
      {/* The whole picture, with the user's own keys, is in Settings → Usage. */}
      <Link href="/settings/org/usage" className="block rounded-sm hover:opacity-80">
        <AllowanceBar view={view} />
      </Link>
      {out && claude === true ? (
        <p className="text-xs text-muted-foreground">
          Outrunner&apos;s models are paused. Sessions on your Claude account keep working.
        </p>
      ) : out ? (
        <>
          <p className="text-xs text-muted-foreground">You&apos;ve used your included usage.</p>
          {claude === false && (
            <NoticeActions actions={[{ label: "Connect Claude", href: providerSettingsHref("claude"), primary: true }]} />
          )}
        </>
      ) : null}
    </div>
  );
}
