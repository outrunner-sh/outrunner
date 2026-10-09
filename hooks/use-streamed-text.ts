"use client";

import { useEffect, useState } from "react";

import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { revealedText, revealRate, revealStep } from "@/lib/session/streaming";

/** How often the reveal advances: smooth to the eye without re-rendering the
 *  Markdown every frame. */
const TICK_MS = 40;

/**
 * A reply revealed as it arrives (lib/session/streaming): `live` text starts
 * hidden and is revealed at a steady pace; history starts whole. Either way,
 * text that grows afterwards (Claude's reply getting longer) is revealed from
 * where it was. Reduced motion shows everything at once.
 */
export function useStreamedText(text: string, live: boolean): { visible: string; streaming: boolean } {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(() => (live ? 0 : text.length));
  const target = text.length;
  const behind = !reduced && shown < target;
  useEffect(() => {
    if (!behind) return;
    // The pace for what has arrived, fixed on the first tick from where the
    // reveal stands (revealRate) and held until all of it is shown; text
    // arriving later restarts this with a new pace. Set inside the updater,
    // which is where the current position is known; the same on a repeat call.
    let rate: number | null = null;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const elapsed = now - last;
      last = now;
      setShown((current) => {
        rate ??= revealRate(current, target);
        return revealStep(current, target, elapsed, rate);
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [behind, target]);

  const count = reduced ? target : Math.min(shown, target);
  return { visible: revealedText(text, count), streaming: count < target };
}
