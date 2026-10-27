import type { LocalSession } from "@/lib/desktop/local-runtime";
import type { Workspace } from "@/lib/runtime/types";

/** The changed set summed up, for the Environment panel's Changes row. */
export type ChangeTotals = { files: number; additions: number; deletions: number };

export function changeTotals(files: readonly { additions: number; deletions: number }[]): ChangeTotals {
  return files.reduce<ChangeTotals>(
    (sum, file) => ({
      files: sum.files + 1,
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

/** The rows above the terminal: what the session works on. */
export type EnvironmentSummary = {
  /** The session's branch; null when Claude edits a folder in place. */
  branch: string | null;
  /** What the branch is compared with; null when there is no branch. */
  baseBranch: string | null;
  /** Where Claude works: the worktree, or the folder itself; null if unknown. */
  workingPath: string | null;
};

export function environmentSummary(
  workspace: Pick<Workspace, "branch" | "baseBranch" | "worktreePath">,
  local?: Pick<LocalSession, "folder" | "worktree" | "branch" | "baseBranch" | "inPlace">,
): EnvironmentSummary {
  if (local) {
    return {
      branch: local.inPlace ? null : local.branch,
      baseBranch: local.inPlace ? null : local.baseBranch || null,
      workingPath: (local.inPlace ? local.folder : local.worktree) || null,
    };
  }
  return {
    branch: workspace.branch || null,
    baseBranch: workspace.branch ? workspace.baseBranch || null : null,
    workingPath: workspace.worktreePath || null,
  };
}
