"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { AllowanceBar } from "@/components/allowance-bar";
import { NoticeActions } from "@/components/ui/notice";
import type { AllowanceView } from "@/lib/openrouter/allowance";
import { PROVIDERS_SETTINGS_HREF } from "@/lib/settings-links";

/**
 * How much of their allowance on Outrunner's models the user has used, as a
 * bar above their account in the sidebar; once it's spent, what to do
 * next (an account or key of their own, unless they have one). Nothing
 * where the server has no per-user allowance (one shared key). Re-read on
 * each page and when the window comes back, as sessions spend it.
 */
export function OutrunnerAllowance() {
  const pathname = usePathname();
  const [view, setView] = useState<AllowanceView | null>(null);
  // Once it's spent: whether they have an account or key of their own to
  // carry on with (null if unknown), so the sidebar never asks for one they have.
  const [ownAccess, setOwnAccess] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const res = await fetch("/api/outrunner-models/usage", { cache: "no-store" });
        if (!res.ok) return; // keep what's shown; the next read may work
        const data = (await res.json()) as { allowance: AllowanceView | null; ownAccess?: boolean | null };
        if (!cancelled) {
          setView(data.allowance);
          setOwnAccess(data.ownAccess ?? null);
        }
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

  if (!view) return null;
  return (
    <div className="space-y-1.5 px-2 pb-3">
      {/* The whole picture, with the user's own keys, is in Settings → Usage. */}
      <Link href="/settings/org/usage" className="block rounded-sm hover:opacity-80">
        <AllowanceBar view={view} />
      </Link>
      {view.state === "out" && ownAccess === true ? (
        <p className="text-xs text-muted-foreground">
          Outrunner&apos;s models are paused. Sessions on your own accounts and keys keep working.
        </p>
      ) : view.state === "out" ? (
        <>
          <p className="text-xs text-muted-foreground">
            You&apos;ve used your included usage. Connect Claude or Codex, or add a provider key, to keep going.
          </p>
          <NoticeActions actions={[{ label: "Use your own account", href: PROVIDERS_SETTINGS_HREF, primary: true }]} />
        </>
      ) : null}
    </div>
  );
}
