"use client";

import { useCallback, useEffect, useState } from "react";

import { localAgentRequest, localTarget, messageForLocalError } from "@/lib/desktop/local-runtime";

/** A question Claude Code is stopped on in a Mac session's terminal: may it
 *  run this command, fetch this page (the agent's PermissionPrompt). */
export type PermissionPrompt = {
  id: string;
  /** What it asks about, e.g. "Bash command". */
  title: string;
  /** Claude Code's own words about it. */
  detail: string[];
  /** The command it would run, as shown. */
  code?: string;
  question: string;
  options: { key: string; label: string; hint?: string }[];
};

/** How often a working session is asked: a prompt shows within this. Each ask
 *  is one tmux capture on this Mac, so it costs next to nothing. */
const POLL_MS = 1500;

/**
 * The prompt a Mac session's Claude is waiting on, if any, and the way to
 * answer it. Claude Code asks in its terminal, and nothing reaches the
 * conversation until it is answered, so without this the chat only shows
 * Claude "working". Asked only while it is (`active`), and while the page is
 * in view. An app from before the call, whose relay refuses it, is simply
 * never asked again.
 */
export function usePermissionPrompt(workspaceId: string, active: boolean) {
  const [prompt, setPrompt] = useState<PermissionPrompt | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      const result = await localAgentRequest<{ prompt: PermissionPrompt | null }>(
        localTarget(workspaceId),
        "GET",
        `/workspaces/${workspaceId}/prompt`,
      );
      setPrompt(result.prompt);
    } catch (error) {
      if (/route-not-allowed|can't do that yet/.test(String(error))) setUnsupported(true);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!active || unsupported) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPrompt(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const tick = async () => {
      if (document.visibilityState === "visible") await read();
      if (live) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active, unsupported, read]);

  const answer = useCallback(
    async (key: string) => {
      if (!prompt) return;
      setAnswering(key);
      setError(null);
      try {
        await localAgentRequest(localTarget(workspaceId), "POST", `/workspaces/${workspaceId}/prompt`, {
          id: prompt.id,
          key,
        });
        setPrompt(null);
      } catch (error) {
        // Most often it changed meanwhile: show what is waiting now.
        setError(messageForLocalError(error));
        await read();
      } finally {
        setAnswering(null);
      }
    },
    [prompt, workspaceId, read],
  );

  return { prompt, answer, answering, error };
}
