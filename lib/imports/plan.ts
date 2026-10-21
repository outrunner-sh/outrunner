/**
 * Planning an import: for each session the user picked on their Mac, either
 * where its artifacts go (a new workspace's Snapshot prefix, and signed upload
 * URLs for each) or why it can't come.
 *
 * Its collaborators are passed in, so it tests without Next or a database.
 */

import type { GitHubRepository } from "@/lib/github/client";
import { isValidBranchName } from "@/lib/runtime/git";
import type { ImportArtifactKind, ImportPlanItem, ImportPlanRequest, ImportSkip } from "@/lib/runtime/import-scan";
import { snapshotPrefix } from "@/lib/runtime/snapshot/paths";

/** How many "-imported-<n>" names are tried for a branch that is taken. */
const RENAME_ATTEMPTS = 20;

export type PlanDeps = {
  /** The repositories the user's token can see, now projects, with their ids. */
  connect(fullNames: string[]): Promise<Array<{ repository: GitHubRepository; projectId: string }>>;
  /** The branches of a project's workspaces that hold theirs (any not destroyed). */
  branchesInUse(projectId: string): Promise<Set<string>>;
  /** When each key was last imported into a workspace still there. */
  importedBefore(keys: string[]): Promise<Map<string, string>>;
  newId(): string;
  now(): Date;
  /** Signed upload URLs for each artifact path. */
  mintUploads(paths: string[]): Promise<Map<string, string>>;
};

/** The Snapshot filename each artifact is stored as. */
export const IMPORT_ARTIFACT_FILES: Record<ImportArtifactKind, string> = {
  bundle: "worktree.bundle",
  patch: "uncommitted.patch",
  conversation: "conversation.jsonl",
  rollout: "rollout.jsonl",
};

export async function planImports(
  ownerId: string,
  request: ImportPlanRequest,
  deps: PlanDeps,
): Promise<ImportPlanItem[]> {
  const repos = [...new Set(request.sessions.map((s) => s.repo.toLowerCase()))];
  const projects = new Map(
    (await deps.connect(repos)).map((p) => [p.repository.fullName.toLowerCase(), p.projectId]),
  );
  const previous = await deps.importedBefore(request.sessions.map((s) => s.key));
  const inUse = new Map<string, Set<string>>();
  const importedAt = deps.now().toISOString();

  const items: ImportPlanItem[] = [];
  const pending: Array<{ index: number; paths: Partial<Record<ImportArtifactKind, string>> }> = [];
  const seen = new Set<string>();
  for (const session of request.sessions) {
    const skipped = (skip: ImportSkip) => items.push({ key: session.key, status: "skipped", skip });
    if (seen.has(session.key)) continue;
    seen.add(session.key);
    if (!session.key.startsWith(`${session.agent}:`)) {
      skipped({ reason: "source-unreadable", detail: "the session's key doesn't match its agent" });
      continue;
    }
    const projectId = projects.get(session.repo.toLowerCase());
    if (!projectId) {
      skipped({ reason: "no-repo-access", detail: `your GitHub account can't see ${session.repo}` });
      continue;
    }
    const before = previous.get(session.key);
    if (before && !session.again) {
      skipped({ reason: "already-imported", detail: `imported ${before}` });
      continue;
    }
    if (!inUse.has(projectId)) inUse.set(projectId, await deps.branchesInUse(projectId));
    const taken = inUse.get(projectId)!;
    const branch = chooseBranch(session.branchAs ?? session.branch, taken, session.branchAs !== undefined);
    if (!branch) {
      skipped({
        reason: "branch-taken",
        detail: `${session.branchAs} is already a session's branch in this project, or isn't a branch name Outrunner takes`,
      });
      continue;
    }
    taken.add(branch); // another picked session can't take it too

    const workspaceId = deps.newId();
    const prefix = snapshotPrefix(ownerId, workspaceId, importedAt);
    const kinds: ImportArtifactKind[] = ["bundle", "patch", "conversation"];
    if (session.agent === "codex") kinds.push("rollout");
    const paths = Object.fromEntries(kinds.map((kind) => [kind, `${prefix}${IMPORT_ARTIFACT_FILES[kind]}`]));
    pending.push({ index: items.length, paths });
    items.push({
      key: session.key,
      status: "ready",
      workspaceId,
      projectId,
      branch,
      renamed: branch !== session.branch,
      importedAt,
      uploads: {},
    });
  }

  const urls = await deps.mintUploads(pending.flatMap((p) => Object.values(p.paths)));
  for (const { index, paths } of pending) {
    const item = items[index];
    if (item.status !== "ready") continue;
    for (const [kind, path] of Object.entries(paths) as Array<[ImportArtifactKind, string]>) {
      item.uploads[kind] = { url: urls.get(path)!, path };
    }
  }
  return items;
}

/**
 * The branch a session is imported as. One the user named is taken as it is
 * or not at all. Its own is kept when free and a name Outrunner takes, else
 * the first free "<branch>-imported[-n]" (from a cleaned-up name if its own
 * isn't one Outrunner takes).
 */
export function chooseBranch(branch: string, taken: Set<string>, named: boolean): string | null {
  if (named) return isValidBranchName(branch) && !taken.has(branch) ? branch : null;
  if (isValidBranchName(branch) && !taken.has(branch)) return branch;
  const base = cleanBranch(branch);
  for (let n = 1; n <= RENAME_ATTEMPTS; n++) {
    const candidate = n === 1 ? `${base}-imported` : `${base}-imported-${n}`;
    if (isValidBranchName(candidate) && !taken.has(candidate)) return candidate;
  }
  return null;
}

/** A branch name with what Outrunner doesn't take replaced. */
function cleanBranch(branch: string): string {
  const cleaned = branch
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/\/\/+/g, "/")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/(\.lock|[./-])+$/, "")
    .slice(0, 100);
  return cleaned || "imported";
}
