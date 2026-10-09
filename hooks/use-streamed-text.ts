"use client";

import { useEffect, useState } from "react";

import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { revealedText, revealStep } from "@/lib/session/streaming";

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
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const elapsed = now - last;
      last = now;
      setShown((current) => revealStep(current, target, elapsed));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [behind, target]);

  const count = reduced ? target : Math.min(shown, target);
  return { visible: revealedText(text, count), streaming: count < target };
}
