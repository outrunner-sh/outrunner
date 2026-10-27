"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { AgentId } from "@/lib/agents/registry";
import { resignInNeedsAccount } from "@/lib/agents/resolve";
import { deliverLocalAgentAuth } from "@/lib/desktop/local-agent-auth";
import {
  localAgentRequest,
  localSocketUrl,
  LocalRuntimeError,
  localTarget,
  type LocalTarget,
} from "@/lib/desktop/local-runtime";
import { SessionUrls, WorkspaceSummary } from "@/lib/runtime/agent-protocol";
import { keepSessionUrls, takeWarmUrls } from "@/lib/session/warm-session";

/**
 * Owner of the Workspace Session's URL lifecycle: fetches
 * POST /api/workspaces/[id]/session, exposes the URLs to child projections,
 * and re-fetches on demand (reconnect / TTL refresh).
 *
 * `attachId` increments every time new URLs arrive. Child hooks watch it to
 * know when to reattach — they never fetch URLs themselves. This is the one
 * place URL freshness is decided; do not duplicate this logic per projection.
 */
export type SessionAttachmentStatus =
  | "idle"
  | "loading"
  | "attached"
  | "error";

export type SessionAttachment = {
  urls: SessionUrls | null;
  status: SessionAttachmentStatus;
  error: string | null;
  /** What the server said went wrong, when it names it: "box-restore-failed"
   *  (the box didn't come back; its disk is kept) or "box-gone" (it can't). */
  errorCode: string | null;
  /** What followed the code, for a local session: the reason the Mac app gave
   *  ("agent-did-not-start: <the runner's last log line>"). */
  errorReason: string | null;
  /** Increments every time `urls` changes (new fetch succeeded). */
  attachId: number;
  /** Fetch fresh URLs, the box's endpoint looked up again too. Idempotent
   *  while a fetch is in flight. */
  refresh: () => void;
  /**
   * Ask the shared attachment owner to refresh after a transient transport
   * close. Calls made by the terminal and event projections are coalesced.
   */
  reconnect: () => void;
};

/**
 * A local session's URLs, from the Outrunner app rather than the server. Start
 * is called first and is idempotent: it leaves a live session alone and
 * continues the conversation of one that is gone (the Mac restarted), signed
 * in as the user picks now.
 */
async function localSessionUrls(target: LocalTarget, agent: AgentId): Promise<SessionUrls> {
  await deliverLocalAgentAuth(target.workspaceId, agent, resignInNeedsAccount(agent));
  await localAgentRequest(target, "POST", `/workspaces/${target.workspaceId}/start`);
  let summary: WorkspaceSummary | undefined;
  try {
    summary = WorkspaceSummary.parse(
      await localAgentRequest(target, "GET", `/workspaces/${target.workspaceId}/summary`),
    );
  } catch {
    // Optional on first paint, as for a cloud session.
  }
  return {
    ptyUrl: localSocketUrl("pty", target),
    eventsUrl: localSocketUrl("events", target),
    ...(summary && { summary }),
  };
}

/**
 * `local` marks a session run by the Outrunner app on this Mac; otherwise the
 * URLs come from the server as for any cloud session. `agent` is the coding
 * agent the session runs.
 */
export function useSessionAttachment(workspaceId: string, local = false, agent: AgentId = "claude"): SessionAttachment {
  const [urls, setUrls] = useState<SessionUrls | null>(null);
  const [status, setStatus] = useState<SessionAttachmentStatus>("idle");
  const [error, setError] = useState<{ message: string; code: string | null; reason: string | null } | null>(null);
  const [attachId, setAttachId] = useState(0);

  const inflight = useRef<AbortController | null>(null);
  // The cloud URLs attached with, and when they were fetched, kept as the page
  // is left (keepSessionUrls) so going back attaches at once.
  const attachedWith = useRef<{ urls: SessionUrls; at: number } | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `fresh` for every attach after the first: something failed, and the box's
  // endpoint the server keeps may be what did (POST …/session?fresh=1).
  const attach = useCallback((fresh: boolean) => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (inflight.current) return;
    const controller = new AbortController();
    inflight.current = controller;
    setStatus("loading");
    // The last failure stays until this attempt has its own answer, so its
    // notice doesn't blink away and back on a retry that fails again.

    (async () => {
      try {
        if (local) {
          const urls = await localSessionUrls(localTarget(workspaceId), agent);
          if (controller.signal.aborted) return;
          setUrls(urls);
          setAttachId((n) => n + 1);
          setStatus("attached");
          setError(null);
          return;
        }
        // The first attach takes the URLs a sidebar warm-up already has.
        const fetchedAt = Date.now();
        // A fresh attach is one because the last URLs failed: they're not kept.
        if (fresh) attachedWith.current = null;
        const warm = fresh ? null : await takeWarmUrls(workspaceId);
        if (controller.signal.aborted) return;
        if (warm) {
          // When the warm-up fetched them isn't known here: kept as of now
          // would outlive them, so they aren't kept again.
          attachedWith.current = null;
          setUrls(warm);
          setAttachId((n) => n + 1);
          setStatus("attached");
          return;
        }
        const res = await fetch(`/api/workspaces/${workspaceId}/session${fresh ? "?fresh=1" : ""}`, {
          method: "POST",
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: string; code?: string }
            | null;
          throw new AttachError(body?.error ?? "Couldn't reach this session's box.", body?.code ?? null);
        }
        const raw = (await res.json()) as unknown;
        const parsed = SessionUrls.safeParse(raw);
        if (!parsed.success) {
          throw new Error("Malformed session response from server");
        }
        attachedWith.current = { urls: parsed.data, at: fetchedAt };
        setUrls(parsed.data);
        setAttachId((n) => n + 1);
        setStatus("attached");
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setStatus("error");
        setError({
          message: err instanceof Error ? err.message : String(err),
          code: err instanceof AttachError || err instanceof LocalRuntimeError ? err.code : null,
          reason: err instanceof LocalRuntimeError ? err.reason : null,
        });
      } finally {
        // An aborted attach may finish after a newer one started; that one's
        // guard isn't ours to clear.
        if (inflight.current === controller) inflight.current = null;
      }
    })();
  }, [workspaceId, local, agent]);
  const refresh = useCallback(() => attach(true), [attach]);

  const reconnect = useCallback(() => {
    // Both browser projections can notice the same network close. The
    // attachment, rather than either projection, owns the retry so that one
    // close produces one fresh pair of short-lived URLs.
    if (inflight.current || reconnectTimer.current) return;
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      refresh();
    }, 500);
  }, [refresh]);

  useEffect(() => {
    attach(false);
    return () => {
      if (attachedWith.current) keepSessionUrls(workspaceId, attachedWith.current.urls, attachedWith.current.at);
      // Handed off: the next attach starts with none of its own.
      attachedWith.current = null;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
      inflight.current?.abort();
      inflight.current = null;
    };
  }, [attach, workspaceId]);

  return {
    urls,
    status,
    error: error?.message ?? null,
    errorCode: error?.code ?? null,
    errorReason: error?.reason ?? null,
    attachId,
    refresh,
    reconnect,
  };
}

class AttachError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = "AttachError";
    this.code = code;
  }
}
