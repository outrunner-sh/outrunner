"use client";

import { SessionUrls } from "@/lib/runtime/agent-protocol";
import { subscribeEventsWs, type EventSubscription } from "@/lib/runtime/session-client";
import { CONVERSATIONS } from "@/lib/session/conversation-cache";

/**
 * How long a warm-up's URLs serve the session's first attach. Well inside both
 * what they're signed for (runtime token: 5 minutes; Daytona's preview URL: at
 * least a minute left, lib/runtime/agent-endpoint-cache.ts), so the page's
 * socket opens on a URL still good to open.
 */
export const WARM_URLS_FOR_MS = 45_000;
/** A sidebar warm-up must never hold opening a session behind a slow probe. */
export const WARM_WAIT_MS = 200;
/** How long a warm-up streams the conversation in when no click follows. */
const WARM_STREAM_FOR_MS = 20_000;
/** How long a `settle` warm-up's stream may say nothing before its history is
 *  taken as all in: a replay comes as fast as the box reads it. */
export const WARM_QUIET_MS = 2_000;

type Warm = { at: number; urls: Promise<SessionUrls | null>; stop: () => void };
const warming = new Map<string, Warm>();

/**
 * Warm a cloud session up as the pointer rests on it in the sidebar: attach
 * (POST …/session?warm=1, which is read-only — it never brings back a box that
 * ended, nor signs the session in or starts it, and says 409 when there is
 * nothing to warm) and stream its conversation into the page's cache, so a
 * click shows it at once and the page attaches with the URLs already in hand.
 * Stops by itself when no click follows. Again within {@link WARM_URLS_FOR_MS}
 * does nothing.
 *
 * `settle` (a prefetch, lib/session/prefetch-sessions.ts) stops it as soon as
 * its history is in, the stream quiet for {@link WARM_QUIET_MS}, rather than
 * keep a socket open for a click that may never come. Done when it stops.
 */
export function warmSession(workspaceId: string, { settle = false }: { settle?: boolean } = {}): Promise<void> {
  const kept = warming.get(workspaceId);
  if (kept && Date.now() - kept.at < WARM_URLS_FOR_MS) return Promise.resolve();
  kept?.stop();

  let stopped = false;
  let subscription: EventSubscription | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let quiet: ReturnType<typeof setTimeout> | null = null;
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const stop = () => {
    stopped = true;
    subscription?.dispose();
    subscription = null;
    if (timer) clearTimeout(timer);
    if (quiet) clearTimeout(quiet);
    done();
  };
  const settling = () => {
    if (!settle || stopped) return;
    if (quiet) clearTimeout(quiet);
    quiet = setTimeout(stop, WARM_QUIET_MS);
  };

  const urls = fetch(`/api/workspaces/${workspaceId}/session?warm=1`, { method: "POST" })
    .then(async (res) => (res.ok ? SessionUrls.safeParse(await res.json()) : null))
    .then((parsed) => (parsed?.success ? parsed.data : null))
    .catch(() => null);

  void urls.then((answer) => {
    if (stopped) return;
    if (!answer?.eventsUrl) return stop();
    subscription = subscribeEventsWs(
      answer.eventsUrl,
      (event, id) => {
        CONVERSATIONS.append(workspaceId, event, id);
        settling();
      },
      { lastEventId: CONVERSATIONS.get(workspaceId)?.lastEventId ?? null, onOpen: settling, onClose: stop },
    );
    timer = setTimeout(stop, WARM_STREAM_FOR_MS);
  });

  warming.set(workspaceId, { at: Date.now(), urls, stop });
  return finished;
}

/**
 * The URLs a warm-up got for this session while still fresh, for its page's
 * first attach, else null. Ends the warm-up's stream: the page opens its own,
 * resuming where the warm-up left the cache.
 */
export async function takeWarmUrls(workspaceId: string): Promise<SessionUrls | null> {
  const warm = warming.get(workspaceId);
  if (!warm) return null;
  warming.delete(workspaceId);
  warm.stop();
  if (Date.now() - warm.at >= WARM_URLS_FOR_MS) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      warm.urls,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), WARM_WAIT_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Keep the URLs a session's page attached with, fetched at `at`, as it's left:
 * going back to it within {@link WARM_URLS_FOR_MS} of their fetch attaches
 * with them at once, as after a warm-up, rather than asking the server again.
 * A warm-up already under way for it is left alone.
 */
export function keepSessionUrls(workspaceId: string, urls: SessionUrls, at: number): void {
  if (Date.now() - at >= WARM_URLS_FOR_MS) return;
  const kept = warming.get(workspaceId);
  if (kept && kept.at >= at) return;
  kept?.stop();
  warming.set(workspaceId, { at, urls: Promise.resolve(urls), stop: () => {} });
}

/** How long the pointer rests on a session before it is warmed up: passing
 *  over the sidebar warms nothing. */
const HOVER_INTENT_MS = 150;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;

/** Warm `workspaceId` up once the pointer has rested on it a moment. */
export function warmOnRest(workspaceId: string): void {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    warmSession(workspaceId);
  }, HOVER_INTENT_MS);
}

/** The pointer moved on before it rested. */
export function cancelWarmOnRest(): void {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = null;
}
