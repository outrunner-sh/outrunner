"use client";

import { ArrowUpRight, Check, Monitor } from "lucide-react";
import { useState } from "react";

import { Spinner } from "@/components/ui/loaders";

/** Shown only after browser onboarding, for an attempt started in the app. */
export function DesktopWelcome({ email, next = "/", expired = false }: { email?: string; next?: string; expired?: boolean }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loopback, setLoopback] = useState<string | null>(null);
  async function openDesktop() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/auth/desktop/handoff", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ next }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not open the desktop app. Please try again.");
      setLoopback(body.loopback);
      window.location.assign(body.deepLink);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not open the desktop app. Please try again.");
    } finally {
      setLoading(false);
    }
  }
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-6 text-center">
        <p aria-hidden className="select-none font-display text-4xl text-foreground/25">outrunner</p>
        <div className="mx-auto flex size-10 items-center justify-center rounded-full border border-border"><Check className="size-4" /></div>
        <div className="space-y-2">
          <h1 className="text-lg font-medium">{expired ? "Continue with Outrunner" : "You’re ready to go"}</h1>
          <p className="text-sm text-muted-foreground">{expired ? "To return to the desktop app, open it and start sign-in again. You can also continue here on the web." : "Continue on the web or open the desktop app. Your setup is ready in both."}</p>
          {email && <p className="text-xs text-muted-foreground">Signed in as {email}</p>}
        </div>
        <div className="space-y-2">
          {!expired && <button type="button" onClick={() => void openDesktop()} disabled={loading} className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {loading ? <Spinner className="size-4" /> : <Monitor className="size-4" />}Open desktop app
          </button>}
          <a href={`/auth/desktop/web?next=${encodeURIComponent(next)}`} className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-input/30 px-4 text-sm hover:bg-input/50">Continue on web<ArrowUpRight className="size-4" /></a>
        </div>
        {loopback && <p role="status" className="text-xs text-muted-foreground">App didn’t open? <a href={loopback} rel="noreferrer" className="underline underline-offset-4">Return to the running desktop app</a> or try Open desktop app again.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
    </main>
  );
}
