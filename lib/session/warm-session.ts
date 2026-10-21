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
/** How long a warm-up streams the conversation in when no click follows. */
const WARM_STREAM_FOR_MS = 20_000;

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
 */
export function warmSession(workspaceId: string): void {
  const kept = warming.get(workspaceId);
  if (kept && Date.now() - kept.at < WARM_URLS_FOR_MS) return;
  kept?.stop();

  let stopped = false;
  let subscription: EventSubscription | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    stopped = true;
    subscription?.dispose();
    subscription = null;
    if (timer) clearTimeout(timer);
  };

  const urls = fetch(`/api/workspaces/${workspaceId}/session?warm=1`, { method: "POST" })
    .then(async (res) => (res.ok ? SessionUrls.safeParse(await res.json()) : null))
    .then((parsed) => (parsed?.success ? parsed.data : null))
    .catch(() => null);

  void urls.then((answer) => {
    if (!answer?.eventsUrl || stopped) return;
    subscription = subscribeEventsWs(
      answer.eventsUrl,
      (event, id) => CONVERSATIONS.append(workspaceId, event, id),
      { lastEventId: CONVERSATIONS.get(workspaceId)?.lastEventId ?? null, onClose: stop },
    );
    timer = setTimeout(stop, WARM_STREAM_FOR_MS);
  });

  warming.set(workspaceId, { at: Date.now(), urls, stop });
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
  return warm.urls;
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
