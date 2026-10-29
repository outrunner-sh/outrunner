"use client";

import { useSyncExternalStore } from "react";

import type { LineQuote } from "@/lib/review/change";

/** What the reviewer means to do with the lines they picked. */
export type QuoteIntent = "ask" | "change";

/** Lines picked in a PR's diff, handed to its chat. `at` tells one pick from
 *  the next, so picking the same lines again still brings the chat up. */
export type PickedQuote = { pr: string; quote: LineQuote; intent: QuoteIntent; at: number };

// The diff (left) and the chat (right) are separate parts of the page: the
// pick is kept here, for the one to hand to the other.
let current: PickedQuote | null = null;
const listeners = new Set<() => void>();

export function pickQuote(pr: string, quote: LineQuote, intent: QuoteIntent): void {
  current = { pr, quote, intent, at: Date.now() };
  for (const listener of listeners) listener();
}

export function dropQuote(): void {
  current = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The lines picked in this PR's diff, if any. */
export function usePickedQuote(pr: string): PickedQuote | null {
  const picked = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  return picked?.pr === pr ? picked : null;
}
