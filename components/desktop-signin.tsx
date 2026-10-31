"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Spinner } from "@/components/ui/loaders";
import { isDesktopApp } from "@/lib/is-desktop";

const subscribe = () => () => {};
const browserSurface = () => false;

type Native = { core?: { invoke?: (command: string, args?: unknown) => Promise<unknown> } };
type Result = { status: "waiting" } | { status: "expired" } | { status: "ready"; ticket: string; verifier: string };

/** The browser owns signup, OAuth and onboarding. This webview only waits for
 * the user's explicit Open desktop app choice and redeems its own session. */
export function DesktopSignIn({ next, children }: { next: string; children: React.ReactNode }) {
  const desktop = useSyncExternalStore(subscribe, isDesktopApp, browserSurface);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const started = useRef<Promise<string> | null>(null);
  const start = useCallback(() => {
    const invoke = (window as unknown as { __TAURI__?: Native }).__TAURI__?.core?.invoke;
    if (!invoke) throw new Error("Update the desktop app and try again.");
    return invoke("desktop_signin_start", { next }) as Promise<string>;
  }, [next]);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invoke = (window as unknown as { __TAURI__?: Native }).__TAURI__?.core?.invoke;
    const wait = async () => {
      try {
        started.current ??= start();
        const state = await started.current;
        if (cancelled) return;
        const poll = async () => {
          if (cancelled) return;
          try {
            const result = await invoke!("desktop_signin_poll", { state }) as Result;
            if (cancelled) return;
            if (result.status === "expired") throw new Error("Sign-in expired. Open the browser again to continue.");
            if (result.status === "waiting") {
              timer = setTimeout(() => void poll(), 1000);
              return;
            }
            const response = await fetch("/auth/desktop/redeem", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ticket: result.ticket, verifier: result.verifier, state }),
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error ?? "Could not finish signing in. Please try again.");
            if (!cancelled) window.location.assign(body.next);
          } catch (error) {
            if (!cancelled) setError(error instanceof Error ? error.message : "Update the desktop app and try again.");
          }
        };
        await poll();
      } catch (error) {
        if (!cancelled) setError(error instanceof Error ? error.message : "Update the desktop app and try again.");
      }
    };
    void wait();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [start, attempt, desktop]);

  if (!desktop) return children;
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-6 text-center">
        <p aria-hidden className="font-display text-4xl text-foreground/25">outrunner</p>
        <div className="space-y-2">
          <h1 className="text-base font-medium">Continue in your browser</h1>
          <p className="text-sm text-muted-foreground">Sign in or create an account and finish setting up Outrunner. Then choose to continue on the web or return to the desktop app.</p>
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : (
          <p role="status" className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" /> Waiting for you in the browser</p>
        )}
        <button type="button" className="text-sm underline underline-offset-4" onClick={() => {
          started.current = null;
          setError(null);
          setAttempt((value) => value + 1);
        }}>Open browser again</button>
      </div>
    </main>
  );
}
