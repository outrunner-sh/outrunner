"use client";

import { useEffect, useRef, useState } from "react";

import { skeletonDecision } from "@/lib/session/skeleton-swap";

/** Whether a load's skeleton is up, by skeletonDecision's rules: none for a
 *  quick load, and never a blink once shown. */
export function useSkeletonSwap(ready: boolean): boolean {
  const [show, setShow] = useState(false);
  const loadingSince = useRef(0);
  const shownAt = useRef<number | null>(null);
  const wasReady = useRef(ready);

  useEffect(() => {
    if (!ready && (wasReady.current || loadingSince.current === 0)) loadingSince.current = performance.now();
    wasReady.current = ready;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const decide = () => {
      const now = performance.now();
      const next = skeletonDecision({ ready, loadingSince: loadingSince.current, shownAt: shownAt.current, now });
      if (next.show && shownAt.current === null) shownAt.current = now;
      if (!next.show) shownAt.current = null;
      setShow(next.show);
      if (next.recheckIn !== null) timer = setTimeout(decide, next.recheckIn);
    };
    decide();
    return () => clearTimeout(timer);
  }, [ready]);

  return show;
}
