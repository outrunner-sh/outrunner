"use client";

import { useSyncExternalStore } from "react";

import { type FirstPrompt, hasFirstPrompt, rememberedFirstPrompt, tabStorage } from "@/lib/session/first-prompt";

const noSubscription = () => () => {};

/**
 * The first prompt waiting for a session's box: the one the URL carries, else
 * the one this tab kept for it, else the one the server kept on the session's
 * row — a tab that never had the prompt (closed and reopened, or another
 * device's) still sees what is queued, and it still goes. Read as the session
 * page will send it, so what is shown as queued is what goes. Storage is the
 * browser's, so the server renders only the URL's.
 */
export function useQueuedFirstPrompt(
  workspaceId: string,
  fromUrl: FirstPrompt,
  stored: FirstPrompt | null = null,
): FirstPrompt | null {
  // A string snapshot: a fresh object per read would never compare equal.
  const kept = useSyncExternalStore(
    noSubscription,
    () => JSON.stringify(rememberedFirstPrompt(tabStorage(), workspaceId)),
    () => "null",
  );
  return hasFirstPrompt(fromUrl) ? fromUrl : ((JSON.parse(kept) as FirstPrompt | null) ?? stored);
}
