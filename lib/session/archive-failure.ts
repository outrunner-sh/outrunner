import { CloudLimitError, isPlanLimitError } from "@/lib/billing/limits";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { OutdatedComputerError } from "@/lib/runtime/session-auth";
import { bringBackFailure, MissingBoxProjectError } from "@/lib/session/box-failure";

export type ArchiveStage = "prepare" | "capture" | "record";

/** Storage preparation failed after the agent answered. Its network error
 * must never be mistaken for an unreachable box. */
export class ArchivePreparationError extends Error {
  constructor(cause: unknown) {
    super("Could not prepare Snapshot uploads.", { cause });
    this.name = "ArchivePreparationError";
  }
}

/** A save failure keeps the session and its disk. Say what failed without
 * exposing signed URLs, provider credentials or command output. */
export function archiveFailure(error: unknown, stage: ArchiveStage): { status: number; error: string } {
  if (error instanceof MissingBoxProjectError) {
    const failure = bringBackFailure(error);
    return { status: failure.status, error: failure.body.error };
  }
  if (error instanceof CloudLimitError) return { status: 403, error: error.denial.error };
  const refused = isPlanLimitError(error);
  if (refused) return { status: 403, error: refused.message };
  if (error instanceof OutdatedComputerError) return { status: 409, error: error.message };
  if (error instanceof AgentRequestError && error.error?.code === "UNAUTHORIZED") {
    return { status: 409, error: "Its box answered, but Outrunner couldn't access the session. The session and its files were kept." };
  }
  // A pending fork's handoff is still on disk. Keep the actionable
  // refusal from chat Snapshots without exposing arbitrary agent diagnostics.
  if (error instanceof AgentRequestError && error.error?.code === "INTERNAL" &&
    /^chat [a-zA-Z0-9_-]+ has an unspent fork handoff; send its first prompt or delete the chat before archiving$/.test(error.error.message)) {
    return { status: 409, error: "One of its chats has a pending fork. Send that chat's first message or delete the chat before archiving. The session and its files were kept." };
  }
  const message = stage === "prepare"
    ? "Outrunner couldn't prepare to save this session. The session and its files were kept."
    : stage === "record"
      ? "Its files were uploaded, but Outrunner couldn't record the Snapshot. The session was kept."
      : "Its files couldn't be saved. The session was kept so its work can be recovered.";
  return { status: 502, error: message };
}
