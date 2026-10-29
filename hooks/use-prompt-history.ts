"use client";

import { useCallback, useEffect, useState } from "react";

import { HISTORY_LIMIT, withPrompt } from "@/lib/session/prompt-history";

/** The page's copy of a user's history, and whose it is: shared by every
 *  composer on the page, kept current as prompts go. */
let current: { owner: string | null; prompts: string[] } = { owner: null, prompts: [] };
/** The read under way, shared while it is; not kept once it settles, so a
 *  read that failed is tried again by the next composer to mount. */
let reading: Promise<string[]> | null = null;
const listeners = new Set<(history: string[]) => void>();

function read(): Promise<string[]> {
  reading ??= fetch("/api/prompt-history")
    .then(async (res) => {
      if (!res.ok) throw Object.assign(new Error(`prompt history: ${res.status}`), { status: res.status });
      const body = (await res.json()) as { prompts?: unknown; owner?: unknown };
      const owner = typeof body.owner === "string" ? body.owner : null;
      const prompts = Array.isArray(body.prompts) ? body.prompts.filter((p): p is string => typeof p === "string") : [];
      // Another user's (the page outlived a sign-out): theirs go. The same
      // user's sent since the page's last read stay ahead of what was read.
      // Before any read the owner is unknown: what was sent then is this page's.
      const same = current.owner === owner || current.owner === null;
      const sent = same ? current.prompts.filter((p) => !prompts.includes(p)) : [];
      current = { owner, prompts: [...sent, ...prompts].slice(0, HISTORY_LIMIT) };
      return current.prompts;
    })
    .finally(() => {
      reading = null;
    });
  return reading;
}

/**
 * The user's prompt history (lib/session/prompt-history.ts), for recall in the
 * composer, and `remember` for a prompt just sent: first in it at once, and
 * kept for the user's other sessions and devices (/api/prompt-history). Read
 * again as each composer mounts, and the page's copy offered only once that
 * read has said whose it is.
 */
export function usePromptHistory(enabled: boolean): { history: string[]; remember: (text: string) => void } {
  const [history, setHistory] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // Listening from the start, so what is sent from here is recalled here
    // even where the read fails.
    listeners.add(setHistory);
    read().then(
      (prompts) => {
        if (live) setHistory(prompts);
      },
      (error: { status?: number }) => {
        // Nobody signed in (a sign-out came between): whose the page's copy
        // is can't be told, so it is let go, and recall starts from what is
        // sent from here on. Any other failure (a 5xx, a blip) leaves it as
        // it is, for the composers that read it fine and this one too, once
        // a read has said whose it is.
        if (error?.status === 401) current = { owner: null, prompts: [] };
        else if (live && current.owner !== null) setHistory(current.prompts);
      },
    );
    return () => {
      live = false;
      listeners.delete(setHistory);
    };
  }, [enabled]);
  const remember = useCallback((text: string) => {
    const next = withPrompt(current.prompts, text);
    if (next === current.prompts) return;
    current = { ...current, prompts: next };
    for (const listener of listeners) listener(current.prompts);
    void fetch("/api/prompt-history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => {
      // Kept on this page; the next read won't have it. Recall is a nicety.
    });
  }, []);
  return { history, remember };
}
