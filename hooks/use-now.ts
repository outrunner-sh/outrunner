"use client";

import { useEffect, useState } from "react";

/**
 * The current time, re-read every `intervalMs` and whenever the page becomes
 * visible again (background tabs throttle timers), so relative labels like
 * "5m" keep aging while a page stays open.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = window.setInterval(tick, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);
  return now;
}
