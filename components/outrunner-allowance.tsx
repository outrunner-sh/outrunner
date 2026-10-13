"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { allowanceView, type Allowance } from "@/lib/openrouter/allowance";
import { cn } from "@/lib/utils";

/**
 * How much of their allowance on Outrunner's models ($5 in total) the user has
 * spent, as a bar above their account in the sidebar; once it's spent, what
 * to do next. Nothing where the server has no per-user allowance (one shared
 * key). Re-read on each page and when the window comes back, as sessions
 * spend it.
 */
export function OutrunnerAllowance() {
  const pathname = usePathname();
  const [allowance, setAllowance] = useState<Allowance | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const res = await fetch("/api/neev-ai/usage", { cache: "no-store" });
        if (!res.ok) return; // keep what's shown; the next read may work
        const data = (await res.json()) as { allowance: Allowance | null };
        if (!cancelled) setAllowance(data.allowance);
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

  if (!allowance) return null;
  const view = allowanceView(allowance);
  return (
    <div className="space-y-1.5 px-2 pb-3">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">Outrunner&apos;s models</span>
        <span className={cn("tabular-nums", view.state === "out" ? "text-destructive" : "text-muted-foreground")}>
          {view.label}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Outrunner's models used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(view.percent)}
        aria-valuetext={view.label}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            view.state === "out" ? "bg-destructive" : view.state === "low" ? "bg-warning" : "bg-foreground/70",
          )}
          style={{ width: `${view.percent}%` }}
        />
      </div>
      {view.state === "out" ? (
        <p className="text-xs text-muted-foreground">
          You&apos;ve used your {view.limit}.{" "}
          <Link href="/settings/claude" className="text-foreground underline underline-offset-4">
            Connect Claude
          </Link>{" "}
          to keep going.
        </p>
      ) : null}
    </div>
  );
}
