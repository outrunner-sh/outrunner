import { CloudLimitError, isPlanLimitError } from "@/lib/billing/limits";
import { AgentRequestError, InvalidSnapshotManifestError } from "@/lib/runtime/agent-client";
import { ErrorCode, SnapshotFailure } from "@/lib/runtime/agent-protocol";
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

/** Old agents already identify rejected uploads in this exact format. Take
 * only the known artifact and status, never the storage body following it. */
function snapshotFailure(error: unknown): SnapshotFailure | undefined {
  if (!(error instanceof AgentRequestError)) return;
  const structured = SnapshotFailure.safeParse(error.error?.snapshot);
  if (structured.success) return structured.data;
  if (error.error?.code !== "INTERNAL") return;
  const upload = /^upload (conversation|cast|bundle|patch|summary|manifest|rollout|chats\/[a-zA-Z0-9_-]+\/(?:conversation|rollout)\.jsonl): unexpected status ([45][0-9]{2}):/.exec(error.error.message);
  if (!upload) return;
  return {
    stage: "upload", cause: "storage_http", httpStatus: Number(upload[2]),
    artifact: upload[1].startsWith("chats/") ? "chat" : upload[1] as SnapshotFailure["artifact"],
  };
}

function snapshotFailureMessage(failure: SnapshotFailure): string {
  const artifact = failure.artifact ? ` (${failure.artifact})` : "";
  const kept = "The session and its files were kept.";
  if (failure.stage === "upload" && failure.cause === "storage_http") {
    const status = failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : "";
    return `Snapshot storage rejected an upload${artifact}${status}. An operator needs to check Snapshot storage. ${kept}`;
  }
  if (failure.stage === "upload" && failure.cause === "network") {
    return `Its box couldn't reach Snapshot storage while uploading${artifact}. ${kept}`;
  }
  if (failure.cause === "missing_file") return `A file needed for its Snapshot is missing on its box${artifact}. The session and its remaining files were kept.`;
  if (failure.cause === "permission_denied") return `Its box couldn't read a file needed for its Snapshot${artifact}. ${kept}`;
  if (failure.cause === "command_failed") {
    const exit = failure.exitCode === undefined ? "" : `; command exited ${failure.exitCode}`;
    return `Its box couldn't capture its repository for the Snapshot${artifact}${exit}. ${kept}`;
  }
  const step = failure.stage === "chats" ? "capture its chats" : failure.stage === "stop" ? "stop its chats for capture" : failure.stage === "upload" ? "upload its Snapshot" : "capture its Snapshot";
  return `Its box couldn't ${step}${artifact}. ${kept}`;
}

/** Persisted in the session's error and returned to its authorized caller.
 * This object deliberately has no raw exception message or arbitrary paths. */
export function archiveFailureReport(error: unknown, stage: ArchiveStage, reference: string) {
  const said = archiveFailure(error, stage);
  const snapshot = snapshotFailure(error);
  const agentCode = error instanceof AgentRequestError ? ErrorCode.safeParse(error.error?.code) : undefined;
  const diagnostic = {
    reference, stage,
    ...(error instanceof AgentRequestError && { agentHttpStatus: error.status }),
    ...(agentCode?.success && { agentCode: agentCode.data }),
    ...(snapshot && { snapshot }),
    ...(error instanceof InvalidSnapshotManifestError && { invalidManifest: true }),
  };
  return { ...said, error: `${said.error} Reference: ${reference}.`, diagnostic };
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
  const snapshot = snapshotFailure(error);
  if (snapshot) return { status: 502, error: snapshotFailureMessage(snapshot) };
  if (stage === "capture" && error instanceof InvalidSnapshotManifestError) {
    return { status: 502, error: "Its box returned an invalid Snapshot manifest. The session and its files were kept." };
  }
  if (stage === "capture" && error instanceof AgentRequestError) {
    const code = ErrorCode.safeParse(error.error?.code);
    return { status: 502, error: `A request to its box failed while saving the Snapshot (HTTP ${error.status}${code.success ? `, ${code.data}` : ""}). The session and its files were kept.` };
  }
  const message = stage === "prepare"
    ? "Outrunner couldn't prepare to save this session. The session and its files were kept."
    : stage === "record"
      ? "Its files were uploaded, but Outrunner couldn't record the Snapshot. The session was kept."
      : "Its files couldn't be saved. The session was kept so its work can be recovered.";
  return { status: 502, error: message };
}
