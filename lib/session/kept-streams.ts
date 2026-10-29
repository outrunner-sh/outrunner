"use client";

import type { AgentEvent, SessionUrls } from "@/lib/runtime/agent-protocol";
import { subscribeEventsWs, type EventSubscription } from "@/lib/runtime/session-client";
import { CONVERSATIONS } from "@/lib/session/conversation-cache";

/**
 * A session's conversation stream, kept open for a while after its page is
 * left, so going back to it takes up the same socket: no attach
 * (POST …/session), no new socket, no replay — what was said meanwhile is
 * already in the page's cache (lib/session/conversation-cache.ts), and the
 * page carries on from the socket as it is.
 *
 * Left, a stream feeds the cache instead of a page, as a sidebar warm-up does
 * (lib/session/warm-session.ts). It is closed when it has been left for
 * {@link KEEP_STREAM_FOR_MS}, when more than {@link STREAMS_KEPT} are left at
 * once, or when the socket drops on its own — a page that comes back then
 * attaches as it always did.
 */

/** How long a stream left by its page stays open for it to come back to. */
export const KEEP_STREAM_FOR_MS = 120_000;
/** How many left streams stay open at once: the most recently left. */
export const STREAMS_KEPT = 3;
/** How many events a left stream holds for its page; past that it closes,
 *  and the page attaches afresh, replaying from its own cursor. */
const MISSED_KEPT = 2_000;

/** What a page hears from its stream: subscribeEventsWs' callbacks. */
export type StreamHandlers = {
  onEvent: (event: AgentEvent, id: string) => void;
  onOpen: () => void;
  onClose: () => void;
  onError: (error: Error) => void;
};

/** A page's hold on its session's stream. */
export type StreamHandle = {
  /** Close it: the page is done with it (its URLs are being replaced). */
  dispose: () => void;
  /** Leave it open for a while, for the page to come back to. */
  leave: () => void;
};

type Stream = {
  workspaceId: string;
  eventsUrl: string;
  urls: SessionUrls;
  subscription: EventSubscription;
  /** The page it feeds; null while left, when it feeds the cache. */
  page: StreamHandlers | null;
  /** What came while it was left, for the page that takes it up: a page kept
   *  alive hidden (React <Activity>) holds the conversation as it was when
   *  it was left, not the cache's. */
  missed: Array<[AgentEvent, string]>;
  open: boolean;
  closed: boolean;
  /** When it was left, for which of several to close first. */
  leftAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const streams = new Map<string, Stream>();

function close(stream: Stream): void {
  if (stream.timer) clearTimeout(stream.timer);
  stream.timer = null;
  stream.page = null;
  stream.missed = [];
  stream.closed = true;
  if (streams.get(stream.workspaceId) === stream) streams.delete(stream.workspaceId);
  stream.subscription.dispose();
}

/**
 * The URLs a left stream of this session was opened with, while it is still
 * open: the page coming back attaches with them, and {@link openStream} then
 * takes up the same socket. Null when there is none to take up.
 */
export function keptStreamUrls(workspaceId: string): SessionUrls | null {
  const stream = streams.get(workspaceId);
  return stream && !stream.closed && stream.page === null ? stream.urls : null;
}

/**
 * Stream `eventsUrl` (one of `urls`) to `page`: the stream this session's
 * page left, if it is still open on the same URL, else a new one resuming
 * from `lastEventId`.
 */
export function openStream(
  workspaceId: string,
  eventsUrl: string,
  urls: SessionUrls,
  lastEventId: string | null,
  page: StreamHandlers,
): StreamHandle {
  const left = streams.get(workspaceId);
  let stream: Stream;
  if (left && !left.closed && left.page === null && left.eventsUrl === eventsUrl) {
    stream = left;
    if (stream.timer) clearTimeout(stream.timer);
    stream.timer = null;
    stream.page = page;
    // Already open: the page is live at once, with what it missed.
    if (stream.open) page.onOpen();
    const missed = stream.missed;
    stream.missed = [];
    for (const [event, id] of missed) page.onEvent(event, id);
  } else {
    if (left) close(left);
    const opened: Stream = {
      workspaceId,
      eventsUrl,
      urls,
      page,
      missed: [],
      open: false,
      closed: false,
      leftAt: 0,
      timer: null,
      subscription: { dispose: () => {}, lastEventId: () => null },
    };
    opened.subscription = subscribeEventsWs(
      eventsUrl,
      (event, id) => {
        if (opened.page) return opened.page.onEvent(event, id);
        CONVERSATIONS.append(workspaceId, event, id);
        opened.missed.push([event, id]);
        if (opened.missed.length > MISSED_KEPT) close(opened);
      },
      {
        lastEventId,
        workspaceId,
        onOpen: () => {
          opened.open = true;
          opened.page?.onOpen();
        },
        onClose: () => {
          const page = opened.page;
          close(opened);
          page?.onClose();
        },
        onError: (error) => opened.page?.onError(error),
      },
    );
    stream = opened;
    streams.set(workspaceId, stream);
  }
  return {
    dispose: () => {
      if (stream.page === page) close(stream);
    },
    leave: () => {
      if (stream.page !== page || stream.closed) return;
      stream.page = null;
      stream.leftAt = Date.now();
      stream.timer = setTimeout(() => close(stream), KEEP_STREAM_FOR_MS);
      // The most recently left stay open; the rest close.
      const left = [...streams.values()].filter((s) => s.page === null).sort((a, b) => b.leftAt - a.leftAt);
      for (const old of left.slice(STREAMS_KEPT)) close(old);
    },
  };
}

/** Close every stream: the user signed out. */
export function closeKeptStreams(): void {
  for (const stream of [...streams.values()]) close(stream);
}
