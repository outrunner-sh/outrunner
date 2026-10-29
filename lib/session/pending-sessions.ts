"use client";

import { store, useStore } from "@/lib/client/store";
import type { Workspace } from "@/lib/runtime/types";

/**
 * The sessions this tab has just started, by id, from the moment the create
 * call answers until the sidebar's own data catches up.
 *
 * The create request answers with the session's row, but the layout's data —
 * which is what a session's page opens from — was read before that row
 * existed. Without this the just-made session's page falls back to asking the
 * server for a session it is already holding, and shows "Opening session"
 * while it does. This is that row, held until the sidebar has it.
 *
 * In memory only, never localStorage: a session that exists is in the
 * database, and one whose creation didn't finish has nothing worth keeping.
 */
export const PENDING_SESSIONS = store<Record<string, Workspace>>({});

/** The same every time, so a hook over it doesn't re-render on every read. */
const NONE: Record<string, Workspace> = {};

/** Keep `workspace`, so its page opens on it at once. */
export function rememberPendingSession(workspace: Workspace): void {
  PENDING_SESSIONS.set({ ...PENDING_SESSIONS.get(), [workspace.id]: workspace });
}

/** Forget it: the sidebar's own data has it now. */
export function forgetPendingSession(id: string): void {
  const pending = PENDING_SESSIONS.get();
  if (!(id in pending)) return;
  const rest = { ...pending };
  delete rest[id];
  PENDING_SESSIONS.set(rest);
}

/** A session this tab started that the sidebar's data doesn't have yet; null
 *  for any other session, and once the sidebar does have it. */
export function usePendingSession(id: string | undefined): Workspace | null {
  const pending = useStore(PENDING_SESSIONS, NONE);
  return (id && pending[id]) || null;
}
