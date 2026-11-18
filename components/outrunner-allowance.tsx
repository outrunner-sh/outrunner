"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { AllowanceBar } from "@/components/allowance-bar";
import type { AllowanceView } from "@/lib/openrouter/allowance";
import { PROVIDERS_SETTINGS_HREF } from "@/lib/settings-links";

/**
 * How much of their allowance on Outrunner's models the user has used, as a
 * compact bar above their account in the sidebar; once it's spent, a single
 * link to what to do next (an account or key of their own, unless they have one). Nothing
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
  const out = view.state === "out";
  // Kept to a bar and, once it's spent, one line: the why is in the tooltip
  // and the whole picture in Settings → Usage, so the sidebar stays free.
  const paused = out && ownAccess === true;
  return (
    <div className="space-y-1 px-2 pb-2.5">
      <Link
        href="/settings/org/usage"
        title={
          paused
            ? "Outrunner's models are paused. Sessions on your own accounts and keys keep working."
            : out
              ? "You've used your included usage."
              : "Your usage of Outrunner's models"
        }
        className="block rounded-sm hover:opacity-80"
      >
        <AllowanceBar view={view} label={paused ? "Outrunner's models · paused" : undefined} compact />
      </Link>
      {out && !paused && (
        <Link
          href={PROVIDERS_SETTINGS_HREF}
          title="Connect Claude or Codex, or add a provider key, to keep going."
          className="block text-[11px] font-medium text-foreground underline-offset-2 hover:underline"
        >
          Use your own account to keep going →
        </Link>
      )}
    </div>
  );
}
