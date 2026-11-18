/**
 * Committing one imported session once its artifacts are uploaded: check they
 * landed where the plan put them, write its Summary and manifest beside them,
 * and make it an archived workspace with that Snapshot — resumed in the cloud
 * by the ordinary Restore.
 *
 * Its collaborators are passed in, so it tests without Next or a database.
 */

import { createHash } from "node:crypto";

import { IMPORT_ARTIFACT_FILES } from "@/lib/imports/plan";
import type { WorkspaceSummary } from "@/lib/runtime/agent-protocol";
import { isValidBranchName } from "@/lib/runtime/git";
import type { ImportCommitRequest } from "@/lib/runtime/import-scan";
import { SNAPSHOT_ARTIFACTS, SnapshotManifest } from "@/lib/runtime/snapshot/manifest";
import { snapshotPrefix } from "@/lib/runtime/snapshot/paths";

/** How long after its plan an import may be committed: its upload URLs are
 *  long expired by then. */
const COMMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Recorded as the Snapshot's runtime; an import ran on no Runtime Computer. */
export const IMPORT_RUNTIME_VERSION = "import-1";

export type CommitDeps = {
  /** The owner's project, or null (another's, or none). */
  getProject(id: string): Promise<{ id: string; defaultBranch: string } | null>;
  branchesInUse(projectId: string): Promise<Set<string>>;
  workspaceExists(id: string): Promise<boolean>;
  /** The sizes of the objects stored under a prefix, by filename. */
  storedSizes(prefix: string): Promise<Map<string, number>>;
  putObject(path: string, body: Buffer, contentType: string): Promise<void>;
  /** The provider an imported session will be restored on. */
  provider(): Promise<string>;
  insertWorkspace(row: {
    id: string;
    projectId: string;
    branch: string;
    baseBranch: string;
    provider: string;
    agent: string;
    title: string | null;
  }): Promise<void>;
  insertSnapshot(row: { workspaceId: string; archivedAt: string; storagePath: string; manifest: SnapshotManifest }): Promise<void>;
  insertImport(row: { workspaceId: string; key: string; source: string; conversationSha256: string; importedAt: string }): Promise<void>;
  /** Undo insertWorkspace (its Snapshot and import rows go with it). */
  deleteWorkspace(id: string): Promise<void>;
  now(): Date;
};

/** An import refused, and the HTTP status to say it with. */
export class ImportError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ImportError";
    this.status = status;
  }
}

export async function commitImport(ownerId: string, req: ImportCommitRequest, deps: CommitDeps): Promise<{ workspaceId: string }> {
  const importedAt = new Date(req.importedAt);
  const age = deps.now().getTime() - importedAt.getTime();
  if (!(age >= 0 && age <= COMMIT_WINDOW_MS)) {
    throw new ImportError("This import's plan has expired. Import the session again.", 409);
  }
  const project = await deps.getProject(req.projectId);
  if (!project) throw new ImportError("That repository isn't yours, or is gone.", 404);
  if (!isValidBranchName(req.branch)) throw new ImportError("That isn't a branch name Outrunner takes.", 400);
  if ((await deps.branchesInUse(project.id)).has(req.branch)) {
    throw new ImportError(`${req.branch} became another session's branch meanwhile. Import it again.`, 409);
  }
  if (await deps.workspaceExists(req.workspaceId)) {
    throw new ImportError("This session was imported already.", 409);
  }

  const prefix = snapshotPrefix(ownerId, req.workspaceId, req.importedAt);
  const stored = await deps.storedSizes(prefix);
  const artifacts = Object.entries(req.artifacts).filter(([, a]) => a !== undefined) as Array<
    [keyof typeof IMPORT_ARTIFACT_FILES, NonNullable<ImportCommitRequest["artifacts"]["rollout"]>]
  >;
  if (req.agent === "codex" && !req.artifacts.rollout) {
    throw new ImportError("A Codex session's rollout is missing.", 400);
  }
  for (const [kind, artifact] of artifacts) {
    const file = IMPORT_ARTIFACT_FILES[kind];
    if (stored.get(file) !== artifact.size) {
      throw new ImportError(`The session's ${kind} didn't finish uploading. Import it again.`, 409);
    }
  }

  const startedAt = req.startedAt ?? req.importedAt;
  const summary: WorkspaceSummary = {
    state: "archived",
    startedAt,
    endedAt: req.importedAt,
    // 0 for a start time that doesn't read as one (NaN).
    duration: Math.max(0, Math.round((importedAt.getTime() - Date.parse(startedAt)) / 1000)) || 0,
    lastActivity: req.importedAt,
    tokenUsage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    changedFiles: req.changedFiles,
    filesTouched: [],
    commitCount: req.unpushed,
    lastAssistantMessage: req.lastMessage ?? null,
  };
  const summaryBytes = Buffer.from(JSON.stringify(summary));
  const checksums: Record<string, string> = {};
  const sizes: Record<string, number> = {};
  const encodings: Record<string, "gzip"> = {};
  for (const [kind, artifact] of artifacts) {
    const file = IMPORT_ARTIFACT_FILES[kind];
    checksums[file] = artifact.sha256;
    sizes[file] = artifact.size;
    if (artifact.encoding) encodings[file] = artifact.encoding;
  }
  checksums[SNAPSHOT_ARTIFACTS.summary] = "sha256:" + createHash("sha256").update(summaryBytes).digest("hex");
  sizes[SNAPSHOT_ARTIFACTS.summary] = summaryBytes.length;

  const manifest = SnapshotManifest.parse({
    version: 1,
    workspaceId: req.workspaceId,
    runtimeVersion: IMPORT_RUNTIME_VERSION,
    claudeVersion: "unknown",
    sessionId: req.sessionId,
    conversation: SNAPSHOT_ARTIFACTS.conversation,
    tree: {
      kind: "git-bundle+patch",
      bundle: SNAPSHOT_ARTIFACTS.bundle,
      patch: SNAPSHOT_ARTIFACTS.patch,
      ...(req.bundleRef !== req.branch && { ref: req.bundleRef }),
    },
    summary: SNAPSHOT_ARTIFACTS.summary,
    ...(req.artifacts.rollout && { rollout: IMPORT_ARTIFACT_FILES.rollout }),
    checksums,
    sizes,
    encodings,
    origin: { source: req.source, key: req.key, worktree: req.worktree, importedAt: req.importedAt },
    startedAt: summary.startedAt,
    archivedAt: req.importedAt,
    lastCommit: req.lastCommit,
    lastMessage: req.lastMessage ?? null,
    tokenUsage: {},
    changedFiles: req.changedFiles,
  });

  // The Snapshot's own files first: a manifest in storage is what marks one
  // complete, so the rows never point at a Snapshot that isn't.
  await deps.putObject(`${prefix}${SNAPSHOT_ARTIFACTS.summary}`, summaryBytes, "application/json");
  await deps.putObject(`${prefix}${SNAPSHOT_ARTIFACTS.manifest}`, Buffer.from(JSON.stringify(manifest)), "application/json");

  await deps.insertWorkspace({
    id: req.workspaceId,
    projectId: project.id,
    branch: req.branch,
    baseBranch: project.defaultBranch,
    provider: await deps.provider(),
    agent: req.agent,
    title: req.title.trim() || null,
  });
  try {
    await deps.insertSnapshot({ workspaceId: req.workspaceId, archivedAt: req.importedAt, storagePath: prefix, manifest });
    await deps.insertImport({
      workspaceId: req.workspaceId,
      key: req.key,
      source: req.source,
      conversationSha256: req.artifacts.conversation.sha256,
      importedAt: req.importedAt,
    });
  } catch (error) {
    await deps.deleteWorkspace(req.workspaceId).catch((cleanup: unknown) =>
      console.error(`Could not remove half-imported workspace ${req.workspaceId}`, cleanup),
    );
    throw error;
  }
  return { workspaceId: req.workspaceId };
}
