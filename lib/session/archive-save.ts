/**
 * Saving a session's work as it's archived (lib/session/archive-session.ts),
 * the part with no network: its box brought back, then its agent asked to
 * capture the Snapshot (redeployed first if it doesn't answer, where the box
 * is up: archive-session.ts). An unreachable box means its work can't be saved,
 * and the archive goes on without it: a box paused, stopped, archived or
 * deleted on the provider, or one that stopped answering, must never keep a
 * session (or the Runner its Ship is) from being archived. Its uncommitted files are then lost, which is said.
 *
 * These failures still stop the archive, as trying again (or upgrading) helps
 * and the files are there to save: the plan refusing the box's start, and a
 * box whose agent answered that it can't archive (too old), and any capture
 * or upload error returned by an agent that still knows the session.
 */

import { CloudLimitError, isPlanLimitError } from "@/lib/billing/limits";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import type { SnapshotManifest } from "@/lib/runtime/snapshot/manifest";
import { OutdatedComputerError } from "@/lib/runtime/session-auth";
import { MissingBoxProjectError } from "@/lib/session/box-failure";

export type ArchiveSaveDeps<Box> = {
  /** Bring the session's box back if it isn't up (bringBack). */
  bringBack(): Promise<void>;
  /** Let the provider settle before the one retry. */
  waitToRetry?(): Promise<void>;
  /** The agent on the box (daytonaAgent). */
  connect(): Promise<Box>;
  /** Capture and upload the Snapshot: its manifest. */
  capture(box: Box): Promise<SnapshotManifest>;
};

/** Saved, with its Snapshot's manifest; or not, and why (for the log). */
export type ArchiveSave = { saved: true; manifest: SnapshotManifest } | { saved: false; cause: unknown };

/** Whether a failure is one to stop the archive for, rather than archive
 *  without the session's work. */
function unknownWorkspace(error: unknown): boolean {
  return error instanceof AgentRequestError && error.status === 404 &&
    error.error?.code === "NOT_FOUND" && error.error.message === "unknown workspace";
}

function stopsArchive(error: unknown): boolean {
  // A replacement for a deleted box answers with this specific envelope.
  // Any other agent answer (upload/tar errors, or an unknown endpoint) means
  // files may still be there and must not be discarded.
  return error instanceof CloudLimitError || isPlanLimitError(error) !== null || error instanceof OutdatedComputerError || error instanceof MissingBoxProjectError ||
    (error instanceof AgentRequestError && !unknownWorkspace(error));
}

/** Save the session's work, or say it couldn't be; throws only for a
 *  failure that stops the archive (stopsArchive). */
export async function saveForArchive<Box>(
  deps: ArchiveSaveDeps<Box>,
  options: { requireSnapshot?: boolean } = {},
): Promise<ArchiveSave> {
  let capturing = false;
  try {
    // Once more before giving up: a box Daytona has just started (from its
    // archive, say) can briefly answer that it's gone, and what's lost
    // otherwise is the session's work.
    await deps.bringBack().catch(async (error: unknown) => {
      if (stopsArchive(error)) throw error;
      await (deps.waitToRetry?.() ?? new Promise((resolve) => setTimeout(resolve, 1_000)));
      return deps.bringBack();
    });
    const box = await deps.connect();
    capturing = true;
    return { saved: true, manifest: await deps.capture(box) };
  } catch (error) {
    const unreachable = (error instanceof TypeError && (error.message === "fetch failed" || error.message === "Failed to fetch")) ||
      (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
    // A malformed manifest or other capture failure is not proof that the
    // box is unreachable. Preserve the session for a retry in those cases.
    if (options.requireSnapshot || stopsArchive(error) || (capturing && !unreachable && !unknownWorkspace(error))) throw error;
    return { saved: false, cause: error };
  }
}

/** What an archive that couldn't save the session's work says, to the user
 *  and on its row. */
export const ARCHIVED_UNSAVED =
  "Archived without its files: its box couldn't be reached, so uncommitted changes on it couldn't be saved. Anything pushed to GitHub is kept.";
