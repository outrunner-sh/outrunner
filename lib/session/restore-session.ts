import { onRuntimeComputer, type Workspace } from "@/lib/runtime/types";

/**
 * Bringing an archived cloud session back when its page opens. A session
 * imported from a Mac is archived, its conversation, commits and changes in a
 * Snapshot (lib/imports/commit.ts), and nothing else in the app restores one:
 * left archived, its page would wait for a box that never comes. The lifecycle
 * route's restore answers once the session is live again, on a box with its
 * conversation back, so its chat shows from the start.
 */

/** Whether opening `workspace` restores it: archived, on a Runtime Computer,
 *  the only kind that restores. */
export function restoresOnOpen(workspace: Pick<Workspace, "status" | "provider">): boolean {
  return workspace.status === "archived" && onRuntimeComputer(workspace.provider);
}

/** How a restore ended: live again, or why not, with the page that fixes it
 *  when one does (Settings → Providers, the plans page). */
export type RestoreOutcome = { ok: true } | { ok: false; error: string; settingsHref: string | null };

/** Restores asked for and not yet answered, by session: a page opened twice
 *  (a remount, a second effect) asks once. */
const inFlight = new Map<string, Promise<RestoreOutcome>>();

/** Restore the archived session `id`. Never throws: a failure is the outcome,
 *  said for the user. */
export function restoreSession(id: string, fetchImpl: typeof fetch = fetch): Promise<RestoreOutcome> {
  const pending = inFlight.get(id);
  if (pending) return pending;
  const request = ask(id, fetchImpl).finally(() => inFlight.delete(id));
  inFlight.set(id, request);
  return request;
}

async function ask(id: string, fetchImpl: typeof fetch): Promise<RestoreOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/workspaces/${id}/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "restore" }),
    });
  } catch {
    return { ok: false, error: "Could not reach Outrunner. Check your connection and try again.", settingsHref: null };
  }
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; settingsHref?: unknown };
  return {
    ok: false,
    error: typeof body.error === "string" ? body.error : "Could not restore this session. Please try again.",
    settingsHref: typeof body.settingsHref === "string" ? body.settingsHref : null,
  };
}
