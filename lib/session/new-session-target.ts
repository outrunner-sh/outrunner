import type { LocalFolder } from "@/lib/desktop/local-runtime";

/** What a new session would run on: a cloud repository or a folder on this Mac. */
export type NewSessionTarget =
  | { kind: "cloud"; project: { defaultBranch: string } | undefined }
  | { kind: "local"; folder: LocalFolder | null };

/** The branch and working copy the new-session screen shows under its picker. */
export type TargetDetails = {
  /** The branch the session starts from; null when there is none to name. */
  branch: string | null;
  /** How the session gets its working copy; null until a target is chosen. */
  worktree: { label: string; title: string } | null;
};

/**
 * The branch and worktree a session on `target` would start with, so the user
 * sees before sending whether Claude gets its own worktree or edits in place.
 * Nothing chosen yet names nothing rather than guessing.
 */
export function newSessionDetails(target: NewSessionTarget): TargetDetails {
  if (target.kind === "cloud") {
    if (!target.project) return { branch: null, worktree: null };
    const branch = target.project.defaultBranch;
    return {
      branch,
      worktree: {
        label: "New worktree",
        title: `A worktree off ${branch} on the cloud computer, on a branch of its own`,
      },
    };
  }

  const { folder } = target;
  if (!folder) return { branch: null, worktree: null };
  if (!folder.git) {
    return {
      branch: null,
      worktree: {
        label: "No worktree",
        title: "Not a git repository: Claude edits the folder in place",
      },
    };
  }
  // A repository whose HEAD is detached has no branch name to show.
  const branch = folder.branch ?? "HEAD";
  return {
    branch,
    worktree: { label: "New worktree", title: `A worktree off ${branch}, on a branch of its own` },
  };
}
