"use client";

import { useState } from "react";

import { reconnectGithub } from "@/components/signin-button";
import { reconnectReturnPath } from "@/lib/auth/redirect";
import { cn } from "@/lib/utils";

/**
 * Trails a GitHub error the API flagged `reconnect: true`: retrying cannot
 * help, only a fresh GitHub token can. One click runs the OAuth round trip
 * again (no sign-out) and comes back to this page with the new token stored.
 */
export function GitHubReconnectLink({ className }: { className?: string }) {
  const [state, setState] = useState<"idle" | "opening" | "failed">("idle");

  async function reconnect() {
    setState("opening");
    try {
      await reconnectGithub(reconnectReturnPath(window.location.pathname, window.location.search));
    } catch (error) {
      console.error("Could not start reconnecting GitHub", error);
      setState("failed");
    }
  }

  return (
    <button
      type="button"
      aria-busy={state === "opening" || undefined}
      onClick={() => {
        if (state !== "opening") void reconnect();
      }}
      className={cn("text-foreground ml-1 font-medium underline underline-offset-2", className)}
    >
      {state === "opening" ? "Opening GitHub…" : state === "failed" ? "Couldn't open GitHub — try again" : "Reconnect GitHub"}
    </button>
  );
}
