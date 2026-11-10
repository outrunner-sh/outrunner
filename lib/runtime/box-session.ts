/**
 * Whether a session is one on a box: the box made for it (its
 * runtime_computers row names it), or one the session records it runs on (a
 * project's shared box from before, workspaces.computer_id). A box's signed
 * request (app/api/runtime/*) speaks for the sessions on it alone, so a
 * box's secret, should a session's code read it, reaches no other session.
 */
export function boxHostsSession(
  computer: { id: string; workspaceId: string | null },
  session: { id: string; computerId: string | null },
): boolean {
  return computer.workspaceId === session.id || session.computerId === computer.id;
}
