"use client";

import Link from "next/link";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { getStartedSteps, showGetStarted } from "@/lib/nav/get-started";
import { cn } from "@/lib/utils";

/** Where the card's own state is kept on this device: skipped, and folded. */
const SKIPPED_KEY = "outrunner.get-started.skipped";
const FOLDED_KEY = "outrunner.get-started.folded";
const CHANGED = "outrunner:get-started";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

/** A flag in localStorage, read without a mismatch: the server (and the first
 *  render) takes `onServer`. */
function useStoredFlag(key: string, onServer: boolean): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    subscribe,
    () => window.localStorage.getItem(key) === "1",
    () => onServer,
  );
  const set = (next: boolean) => {
    if (next) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
    window.dispatchEvent(new Event(CHANGED));
  };
  return [on, set];
}

/**
 * "Get started" in the sidebar: a short checklist for a new user (lib/nav/
 * get-started.ts), each step a link to where it's done. It goes once every
 * step is, or when the user skips it. Skipped on the server, so a user who
 * skipped it never sees it flash in.
 */
export function GetStarted({ projects, sessions }: { projects: number; sessions: number }) {
  const [skipped, setSkipped] = useStoredFlag(SKIPPED_KEY, true);
  const [folded, setFolded] = useStoredFlag(FOLDED_KEY, false);
  const [claudeConnected, setClaudeConnected] = useState<boolean | null>(null);

  useEffect(() => {
    if (skipped) return;
    let cancelled = false;
    const read = async () => {
      try {
        const res = await fetch("/api/settings/claude", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { connected?: boolean };
        if (!cancelled) setClaudeConnected(Boolean(data.connected));
      } catch {
        // Offline: the step stays as it was, and the next look may work.
      }
    };
    void read();
    // Connected in Settings, or in another window: seen on the way back.
    window.addEventListener("focus", read);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", read);
    };
  }, [skipped]);

  const steps = getStartedSteps({ projects, sessions, claudeConnected });
  if (!showGetStarted(steps, skipped)) return null;
  const done = steps.filter((s) => s.done).length;

  return (
    <section className="mx-1 mb-3 rounded-lg border border-border/60" aria-label="Get started">
      <button
        type="button"
        onClick={() => setFolded(!folded)}
        aria-expanded={!folded}
        className="flex w-full items-center gap-2 px-3 pt-3 text-left"
      >
        <span className="text-sm font-medium">Get started</span>
        <span className="text-xs text-muted-foreground">
          {done}/{steps.length}
        </span>
        <ChevronDown
          className={cn("ml-auto size-4 text-muted-foreground transition-transform", folded && "-rotate-90")}
        />
      </button>
      <div className="mx-3 mt-2.5 h-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-foreground transition-[width]" style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      {!folded && (
        <>
          <ul className="space-y-0.5 px-1.5 py-2">
            {steps.map((step) => (
              <li key={step.id}>
                <Link
                  href={step.href}
                  aria-disabled={step.done || undefined}
                  tabIndex={step.done ? -1 : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-sm",
                    step.done ? "pointer-events-none text-muted-foreground line-through" : "hover:bg-accent",
                  )}
                >
                  {step.done ? (
                    <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                  ) : (
                    <span className="size-4 shrink-0 rounded-full border border-dashed border-muted-foreground" />
                  )}
                  {step.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="border-t border-border/60 px-3 py-2">
            <button
              type="button"
              onClick={() => setSkipped(true)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Skip
            </button>
          </div>
        </>
      )}
    </section>
  );
}
