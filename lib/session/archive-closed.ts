/**
 * Archiving a session because what it worked on closed (a GitHub issue or pull
 * request, a Linear issue): a snapshot, restorable, as its owner. A session
 * that went to sleep, as most have by then, is woken for it, since its snapshot
 * is taken on its box. One mid another step is left as it is.
 */

export type ClosedSession = { id: string; ownerId: string; status: string };

export type ArchiveClosedDeps = {
  wake(ownerId: string, workspaceId: string): Promise<boolean>;
  suspend(ownerId: string, workspaceId: string): Promise<unknown>;
  archiveServerSessions(userId: string, workspaceIds: readonly string[]): Promise<number>;
};

/** How many were archived: this one, or none. `from` and `what` are for the log
 *  ("GitHub", "owner/repo#1"). */
export async function archiveClosedSession(session: ClosedSession, from: string, what: string, deps: ArchiveClosedDeps): Promise<number> {
  const s = session;
  if (s.status === "archived") return 0;
  if (s.status !== "ready" && s.status !== "idle" && s.status !== "suspended") {
    // Mid another step (suspending, resuming, restoring): left as it is.
    console.warn(`${from}: session ${s.id} was ${s.status} as ${what} closed, so it wasn't archived`);
    return 0;
  }
  const woken = s.status === "suspended";
  if (woken && !(await deps.wake(s.ownerId, s.id).catch(() => false))) {
    console.warn(`${from}: session ${s.id} couldn't be woken to archive it as ${what} closed`);
    return 0;
  }
  const done = await deps.archiveServerSessions(s.ownerId, [s.id]);
  if (done === 0 && woken) {
    // Woken for nothing: back to sleep, rather than up until it idles.
    console.warn(`${from}: session ${s.id} was woken but not archived as ${what} closed; putting it back to sleep`);
    await deps.suspend(s.ownerId, s.id).catch((error: unknown) => console.error(`${from}: couldn't suspend ${s.id} again`, error));
  }
  return done;
}
