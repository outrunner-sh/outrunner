/**
 * A box row that lost track of its box, and the box it lost.
 *
 * Before 20261112100000_claim_keeps_ended_box.sql, claiming a stopped box to
 * bring it back cleared the row's daytona_sandbox_id, and the request doing
 * it wrote the id back in a second statement. A request cut off between the
 * two (a deploy rolling the control plane mid-attach) left the row
 * provisioning, naming no box; the abandoned-claim sweep then made it
 * `error`, still naming none. The box itself, paused with the session's
 * files on its disk, was fine, but nothing named it: every open of the
 * session failed, and the orphaned-box sweep deleted it after two hours.
 *
 * The box is still known: compute_intervals records every box a computer
 * ran on, newest last. These rules, free of the database, say when a row has
 * lost its box (so a session's open brings that box back rather than giving
 * up) and when a box is a lost one (so the orphan sweep keeps it).
 */

import type { RuntimeComputerStatus } from "@/lib/runtime/types";

/** Statuses a row can be left in by a cut-off claim: still claimed, or let
 *  go by the abandoned-claim sweep. `stopped` with no box is a box deleted on
 *  purpose (with its session), never a lost one. */
const LEFT_BY_CUT_OFF_CLAIM: ReadonlySet<RuntimeComputerStatus> = new Set(["provisioning", "error"]);

/** Whether a row in `status` naming `sandboxId` may have lost its box, so
 *  the box it last ran on is worth looking up. */
export function mayHaveLostBox(row: { status: RuntimeComputerStatus; daytonaSandboxId: string | null }): boolean {
  return row.daytonaSandboxId === null && LEFT_BY_CUT_OFF_CLAIM.has(row.status);
}

/** A metered stretch of a computer's box: which box, from when. */
export type MeteredBox = { computerId: string; sandboxId: string; startedAt: string };

/** Each computer's newest box, by its intervals' start. */
export function lastBoxes(intervals: readonly MeteredBox[]): Map<string, string> {
  const newest = new Map<string, MeteredBox>();
  for (const interval of intervals) {
    const was = newest.get(interval.computerId);
    if (!was || Date.parse(interval.startedAt) > Date.parse(was.startedAt)) newest.set(interval.computerId, interval);
  }
  return new Map([...newest].map(([computerId, interval]) => [computerId, interval.sandboxId]));
}

/**
 * Of the boxes in `intervals`, those a row lost: the newest box of a computer
 * whose row (in `rows`) may have lost it (mayHaveLostBox). The orphan sweep
 * keeps them, as a session's next open brings them back.
 */
export function lostBoxes(
  intervals: readonly MeteredBox[],
  rows: readonly { id: string; status: RuntimeComputerStatus; daytonaSandboxId: string | null }[],
): Set<string> {
  const last = lastBoxes(intervals);
  const lost = new Set<string>();
  for (const row of rows) {
    const box = last.get(row.id);
    if (box && mayHaveLostBox(row)) lost.add(box);
  }
  return lost;
}
