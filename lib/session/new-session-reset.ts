"use client";

import { store, useStore } from "@/lib/client/store";

/**
 * A fresh new-session form on every "New Session" (the sidebar's, ⌘N, a
 * project's "+"), even when /new is already open or kept from before: the
 * form is keyed on how many have been asked for. Going back to /new any other
 * way (the browser's back) keeps the form as it was left. Fresh is the
 * repository, folder and cloud/Mac choice: the prompt being written, and its
 * files, are a draft kept until sent (lib/client/drafts.ts), so they stay.
 */
const ASKED = store(0);

export function startNewSession(): void {
  ASKED.set(ASKED.get() + 1);
}

export function useNewSessionCount(): number {
  return useStore(ASKED, 0);
}
