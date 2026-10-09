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

/** The rows above the terminal: where the session runs and what it works on. */
export type EnvironmentSummary = {
  /** `detail` names the machine or folder, for the row's tooltip. */
  location: { kind: "cloud" | "local"; label: string; detail: string };
  /** The session's branch; null when Claude edits a folder in place. */
  branch: string | null;
  /** What the branch is compared with; null when there is no branch. */
  baseBranch: string | null;
  /** Where Claude works: the worktree, or the folder itself; null if unknown. */
  workingPath: string | null;
};

export function environmentSummary(
  workspace: Pick<Workspace, "provider" | "branch" | "baseBranch" | "worktreePath">,
  local?: Pick<LocalSession, "name" | "folder" | "worktree" | "branch" | "baseBranch" | "inPlace">,
): EnvironmentSummary {
  if (local) {
    return {
      location: { kind: "local", label: "Local", detail: `This Mac · ${local.name}` },
      branch: local.inPlace ? null : local.branch,
      baseBranch: local.inPlace ? null : local.baseBranch || null,
      workingPath: (local.inPlace ? local.folder : local.worktree) || null,
    };
  }
  return {
    location: {
      kind: "cloud",
      label: "Cloud",
      // Daytona sessions share the project's Runtime Computer; the others each
      // have a sandbox of their own, named by their provider.
      detail: workspace.provider === "daytona" ? "runtime-computer" : workspace.provider,
    },
    branch: workspace.branch || null,
    baseBranch: workspace.branch ? workspace.baseBranch || null : null,
    workingPath: workspace.worktreePath || null,
  };
}
