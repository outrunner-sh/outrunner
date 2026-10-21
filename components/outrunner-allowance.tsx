"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { AllowanceBar } from "@/components/allowance-bar";
import type { AllowanceView } from "@/lib/openrouter/allowance";
import { providerSettingsHref, USAGE_SETTINGS_HREF } from "@/lib/settings-links";

/**
 * How much of their allowance on Outrunner's models the user has used, as a
 * bar above their account in the sidebar; once it's spent, what
 * to do next. Nothing where the server has no per-user allowance (one shared
 * key). Re-read on each page and when the window comes back, as sessions
 * spend it.
 */
export function OutrunnerAllowance() {
  const pathname = usePathname();
  const [view, setView] = useState<AllowanceView | null>(null);

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

  if (!view) return null;
  return (
    <div className="space-y-1.5 px-2 pb-3">
      {/* The whole picture, with the user's own keys, is in Settings → Usage. */}
      <Link href={USAGE_SETTINGS_HREF} className="block rounded-sm hover:opacity-80">
        <AllowanceBar view={view} />
      </Link>
      {view.state === "out" ? (
        <p className="text-xs text-muted-foreground">
          You&apos;ve used your included usage.{" "}
          <Link href={providerSettingsHref("claude")} className="text-foreground underline underline-offset-4">
            Connect Claude
          </Link>{" "}
          to keep going.
        </p>
      ) : null}
    </div>
  );
}
