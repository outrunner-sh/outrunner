"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentEvent } from "@/lib/runtime/agent-protocol";
import { appendEvent } from "@/lib/runtime/conversation-events";
import { dropNarration, rearmedSince, reconnectPlan } from "@/lib/runtime/reconnect";
import { StreamProtocolError, subscribeEventsWs } from "@/lib/runtime/session-client";
import { CONVERSATIONS } from "@/lib/session/conversation-cache";

import type { SessionAttachment } from "./use-session-attachment";

export type ConversationStreamState = {
  events: AgentEvent[];
  status: "loading" | "connecting" | "connected" | "disconnected" | "error";
  error: string | null;
  /** Set while the automatic reconnect loop is running after a drop. `attempt`
   *  is 0 for a retry re-armed by focus/visibility/online, before it is counted. */
  reconnecting: { attempt: number; max: number; since: number } | null;
  /** Automatic retry gave up; the session itself is untouched on its box. */
  lost: boolean;
  /** A reconnect the user asked for is under way: the "lost connection" notice
   *  stays (its button spinning) rather than blinking "Reconnecting…". */
  retrying: boolean;
  /** A frame the browser couldn't read, by the reference it was logged under.
   *  Stays set until the page reloads: the frame's event is missing from the
   *  timeline, and resuming from the cursor would not bring it back. */
  protocolErrorRef: string | null;
  /** Force a full URL refresh + re-subscribe. Preserves the resume cursor. */
  refresh: () => void;
};

// Reconnect backoff lives in lib/runtime/reconnect (pure + unit-tested). Unlike
// EventSource (which absorbs blips with its own retry), a WS close here triggers
// a full reconnect — refetch URLs + a fresh token + a new socket — so the policy
// backs off exponentially and gives up after a bounded number of consecutive
// failures rather than hammering /session against a genuinely-down endpoint.

// A single {error, closed, live} slice: reducer keeps effect body free of
// setState, and the signals update from the same subscribe callbacks. `live`:
// a frame has arrived on this connection.
type WsStatus = {
  error: string | null;
  closed: boolean;
  live: boolean;
  /** Consecutive failed reconnects, mirrored from the ref for rendering. */
  attempt: number;
  /** When the current run of drops began (ms), for the elapsed time shown. */
  since: number | null;
  gaveUp: boolean;
  protocolErrorRef: string | null;
};
type WsAction =
  | { kind: "opening" }
  | { kind: "frame-received" }
  | { kind: "closed"; attempt: number; at: number }
  | { kind: "gave-up" }
  | { kind: "rearm"; at: number }
  | { kind: "error"; message: string }
  | { kind: "protocol-error"; ref: string };

const OPEN: WsStatus = { error: null, closed: false, live: false, attempt: 0, since: null, gaveUp: false, protocolErrorRef: null };

function wsReducer(state: WsStatus, action: WsAction): WsStatus {
  switch (action.kind) {
    case "opening":
      // A new connection (a reconnect, or the page shown again): not live
      // until its first frame.
      return state.live ? { ...state, live: false } : state;
    case "frame-received":
      // First frame after connect implicitly means we're open again.
      return state.live && !state.closed && state.error === null
        ? state
        : { ...OPEN, live: true, protocolErrorRef: state.protocolErrorRef };
    case "closed":
      return { ...state, closed: true, live: false, attempt: action.attempt, since: state.since ?? action.at };
    case "gave-up":
      return { ...state, gaveUp: true };
    case "rearm":
      // A fresh retry budget starts a fresh clock (rearmedSince): otherwise a
      // give-up, then a focus an hour later, would time this run from the drop
      // it recovered from.
      return { ...state, attempt: 0, gaveUp: false, since: rearmedSince(state.closed, action.at) };
    case "error":
      return { ...state, error: action.message };
    case "protocol-error":
      return { ...state, protocolErrorRef: state.protocolErrorRef ?? action.ref };
  }
}

/**
 * Subscribe to the Workspace Session's AgentEvent stream. State events (which
 * aren't resumable) are re-observed on every fresh connect and de-duplicated
 * so status stays consistent; message/usage events are keyed by the SSE `id`
 * (JSONL byte offset), so a duplicate delivery — which the resume protocol
 * makes impossible in the happy path, but defensive dedup guards against
 * client-side races on double-subscribe — never renders twice.
 *
 * The hook owns the `lastEventId` cursor across reconnects; the useSessionAttachment
 * hook re-fetches URLs, but the cursor survives so subscribeEvents starts
 * from exactly where we left off.
 *
 * The conversation is kept for the page (lib/session/conversation-cache.ts):
 * a session opened before, or warmed up from the sidebar, shows at once and
 * its stream resumes from the kept cursor. One kept from before a reload
 * (lib/session/kept-conversations.ts) shows at once too, its stream replaying
 * from the start.
 */
export function useConversationStream(attachment: SessionAttachment, workspaceId: string): ConversationStreamState {
  const {
    urls,
    status: attachmentStatus,
    error: attachmentError,
    attachId,
    reconnect,
    refresh,
  } = attachment;
  const [kept] = useState(() => CONVERSATIONS.get(workspaceId));
  const [events, setEvents] = useState<AgentEvent[]>(kept?.events ?? []);
  const [ws, dispatch] = useReducerState();
  const lastEventIdRef = useRef<string | null>(kept?.lastEventId ?? null);
  // A copy: a sidebar warm-up may still be adding to the kept one.
  const seenIdsRef = useRef<Set<string>>(new Set(kept?.seenIds));
  // Keep what this page has seen for the next time the session is opened.
  useEffect(() => {
    CONVERSATIONS.set(workspaceId, {
      events,
      lastEventId: lastEventIdRef.current,
      seenIds: seenIdsRef.current,
    });
  }, [workspaceId, events]);
  // Consecutive failed reconnects (reset by any received frame). A ref, not
  // reducer state, so the onClose closure reads the live count, not a stale one.
  const reconnectAttemptsRef = useRef(0);
  // A reconnect this user asked for. It keeps the "lost connection" notice on
  // screen — its button spinning — until it lands; the automatic retry stays
  // quiet rather than blinking "Reconnecting…" over the button just pressed.
  // A fresh close (its socket dying too) hands the story back to the automatic
  // narration, and so does the first frame of a retry that lands.
  const [manualRetry, setManualRetry] = useState(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const url = urls?.eventsUrl;
    if (!url || attachmentStatus !== "attached") return;

    let active = true;
    dispatch({ kind: "opening" });

    const sub = subscribeEventsWs(
      url,
      (event, id) => {
        // Message/usage events are deduplicated by SSE id. State events use a
        // synthetic id ("0"): they aren't resumable and are re-observed on
        // fresh connects, so we replace the newest state entry instead.
        setEvents((prev) => appendEvent(prev, event, id, seenIdsRef.current));
        if (id && id !== "0") lastEventIdRef.current = id;
        // A live frame means this connection is healthy: clear the backoff.
        reconnectAttemptsRef.current = 0;
        setManualRetry(false);
        dispatch({ kind: "frame-received" });
      },
      {
        lastEventId: lastEventIdRef.current,
        workspaceId,
        onClose: () => {
          if (!active) return;
          setManualRetry(false);
          const attempt = (reconnectAttemptsRef.current += 1);
          dispatch({ kind: "closed", attempt, at: Date.now() });
          const plan = reconnectPlan(attempt);
          if (!plan.retry) {
            // Automatic retry is exhausted (e.g. endpoint permanently down). Not
            // a dead end: the visibility/focus/online effect re-arms this when
            // the app becomes active again, and the user can refresh to retry.
            dispatch({ kind: "gave-up" });
            dispatch({ kind: "error", message: "Lost connection to this session." });
            return;
          }
          // Back off, then let the shared attachment refetch URLs (coalescing
          // simultaneous terminal + events closes into one refresh).
          reconnectTimerRef.current = setTimeout(() => {
            if (active) reconnect();
          }, plan.delayMs);
        },
        onError: (err) =>
          dispatch(
            err instanceof StreamProtocolError
              ? { kind: "protocol-error", ref: err.ref }
              : { kind: "error", message: err.message },
          ),
      },
    );

    return () => {
      active = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      sub.dispose();
    };
  }, [attachId, attachmentStatus, dispatch, reconnect, urls?.eventsUrl, workspaceId]);

  // Idle recovery. A backgrounded/hidden webview (the desktop app hides to the
  // tray) can have its socket suspended, so every backoff retry fails and we
  // land in the closed/give-up state until the user does something — the "error
  // when idle, works the moment I send a message" symptom. When the app becomes
  // visible, regains focus, or the network returns, reset the retry budget and
  // reconnect at once so the stream is healthy again before the next prompt,
  // instead of waiting for a POST to incidentally revive it.
  //
  // Re-arm only for a transport loss: `ws.closed` (the socket dropped) or an
  // attachment "error" (a /session refetch that failed, e.g. offline, so a
  // returning network can retry it). A protocol error on a still-open socket
  // (`ws.error` while `ws.closed` is false) must NOT trigger this — reconnecting
  // would tear down a healthy socket on the next focus. reconnect() just
  // schedules refresh(), so it is safe to arm during "error" as well as
  // "attached".
  const transportLost = ws.closed || attachmentStatus === "error";
  useEffect(() => {
    if (attachmentStatus !== "attached" && attachmentStatus !== "error") return;
    if (!transportLost) return;
    const rearm = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      reconnectAttemptsRef.current = 0;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      dispatch({ kind: "rearm", at: Date.now() });
      reconnect();
    };
    document.addEventListener("visibilitychange", rearm);
    window.addEventListener("focus", rearm);
    window.addEventListener("online", rearm);
    return () => {
      document.removeEventListener("visibilitychange", rearm);
      window.removeEventListener("focus", rearm);
      window.removeEventListener("online", rearm);
    };
  }, [attachmentStatus, transportLost, reconnect, dispatch]);

  const status = useMemo<ConversationStreamState["status"]>(() => {
    if (attachmentStatus === "loading") return "loading";
    if (attachmentStatus === "error") return "error";
    if (ws.error && ws.closed) return "error";
    if (ws.closed) return "disconnected";
    // We consider ourselves "connected" once at least one frame arrived on
    // this connection (the agent emits an initial state event on every fresh
    // connect, so this resolves within one round trip). Before that, we're
    // still connecting, whatever was kept from before.
    return ws.live ? "connected" : "connecting";
  }, [attachmentStatus, ws.error, ws.closed, ws.live]);

  // A failed /session refetch is its own error with its own message, so the
  // reconnect notices give way to it. What the drop says on screen — the
  // automatic retry's narration, or lost — is reconnect.ts' to decide.
  const { reconnecting, lost } = dropNarration({
    dropped: ws.closed && attachmentStatus !== "error",
    gaveUp: ws.gaveUp,
    manual: manualRetry,
    attempt: ws.attempt,
    since: ws.since,
  });
  // A manual reconnect starts a fresh retry budget, as the idle re-arm does;
  // otherwise the next drop after giving up would give up at once.
  const refreshStream = useCallback(() => {
    setManualRetry(true);
    reconnectAttemptsRef.current = 0;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    dispatch({ kind: "rearm", at: Date.now() });
    refresh();
  }, [dispatch, refresh]);

  return {
    events,
    status,
    error: ws.error ?? attachmentError,
    reconnecting,
    lost,
    retrying: manualRetry,
    protocolErrorRef: ws.protocolErrorRef,
    refresh: refreshStream,
  };
}

// Small helper to hide useReducer typing; keeps the hook readable.
function useReducerState() {
  const [state, setState] = useState<WsStatus>(OPEN);
  const dispatch = useMemo(
    () => (action: WsAction) => setState((s) => wsReducer(s, action)),
    [],
  );
  return [state, dispatch] as const;
}
