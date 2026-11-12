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
export const LEFT_BY_CUT_OFF_CLAIM: readonly RuntimeComputerStatus[] = ["provisioning", "error"];

/** Whether a row in `status` naming `sandboxId` may have lost its box, so
 *  the box it last ran on is worth keeping. */
export function mayHaveLostBox(row: { status: RuntimeComputerStatus; daytonaSandboxId: string | null }): boolean {
  return row.daytonaSandboxId === null && LEFT_BY_CUT_OFF_CLAIM.includes(row.status);
}

/**
 * Whether opening a session brings its row back on the box it last ran on:
 * only once the claim is let go of (`error`). One still `provisioning` is a
 * claim the database hands to no one else (claim_workspace_computer), so a
 * box found for it would go unused; the abandoned-claim sweep lets it go.
 */
export function bringsBackLostBox(row: { status: RuntimeComputerStatus; daytonaSandboxId: string | null }): boolean {
  return row.status === "error" && mayHaveLostBox(row);
}

/**
 * Of `candidates` (boxes the orphan sweep would delete), those a row lost:
 * the newest box (`lastBox`, from its intervals) of a row that may have lost
 * it (mayHaveLostBox). The sweep keeps them, as a session's next open brings
 * them back.
 */
export function lostBoxes(
  rows: readonly { status: RuntimeComputerStatus; daytonaSandboxId: string | null; lastBox: string | null }[],
  candidates: ReadonlySet<string>,
): Set<string> {
  const lost = new Set<string>();
  for (const row of rows) {
    if (row.lastBox && candidates.has(row.lastBox) && mayHaveLostBox(row)) lost.add(row.lastBox);
  }
  return lost;
}
