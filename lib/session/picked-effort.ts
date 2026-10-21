import { type Effort, isEffort } from "@/lib/runtime/session-models";

/**
 * The effort a session was last put on from this browser, so its composer can
 * show it: a reply names the model it ran, but not how hard it thought. Kept
 * per session, as the provider picked is; a session started elsewhere shows
 * the model's own until one is picked here.
 */

const key = (workspaceId: string) => `outrunner:effort:${workspaceId}`;

/** The effort remembered for a session; null when none is (the model's own). */
export function rememberedEffort(workspaceId: string): Effort | null {
  try {
    const saved = window.localStorage.getItem(key(workspaceId));
    return isEffort(saved) ? saved : null;
  } catch {
    return null;
  }
}

/** Remember `effort` for a session; null forgets it (the model's own). */
export function rememberEffort(workspaceId: string, effort: Effort | null): void {
  try {
    if (effort) window.localStorage.setItem(key(workspaceId), effort);
    else window.localStorage.removeItem(key(workspaceId));
  } catch {
    // Blocked storage only costs the bars going back to the model's own.
  }
}
