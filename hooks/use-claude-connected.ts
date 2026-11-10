"use client";

import { useEffect, useState } from "react";

/**
 * Whether the user's own Claude is connected (/api/settings/claude): null
 * until first known, `failed` once a read didn't answer. Read while
 * `enabled`, again on `refreshKey` changing and when the window comes back
 * (connected in Settings, or in another window).
 */
export function useClaudeConnected(enabled: boolean, refreshKey?: unknown): { connected: boolean | null; failed: boolean } {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const read = async () => {
      try {
        const res = await fetch("/api/settings/claude", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { connected?: boolean };
        if (!cancelled) {
          setConnected(Boolean(data.connected));
          setFailed(false);
        }
      } catch {
        // Offline or a server error: what's known stays, and the next look may work.
        if (!cancelled) setFailed(true);
      }
    };
    void read();
    window.addEventListener("focus", read);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", read);
    };
  }, [enabled, refreshKey]);

  return { connected, failed };
}
