/**
 * Settings → Archived sessions: the sessions archived out of the sidebar
 * (lib/nav/sidebar.ts), to look back over or bring back. Pure, so the listing
 * and search are tested without React.
 */

import { workspaceLabel } from "@/lib/nav/session-title";
import type { Workspace } from "@/lib/runtime/types";
import { ARCHIVED_UNSAVED } from "@/lib/session/archive-notice";

export type ArchivedSession = {
  id: string;
  title: string;
  /** Its repository, `owner/repo`; empty when it can't be read. */
  project: string;
  branch: string;
  /** When it was archived: its row's last change, which the archive was. */
  archivedAt: string;
  /** Its Snapshot was kept, so it can be viewed and restored. False for one
   *  archived while its box was out of reach (lib/session/archive-save.ts). */
  saved: boolean;
  /** Still being archived: nothing to view or restore yet. */
  archiving: boolean;
};

/** The archived sessions among `workspaces`, most recently archived first.
 *  Missions and their Ships are left to the Missions section, as in the
 *  sidebar. */
export function archivedSessions(
  workspaces: Workspace[],
  projects: Array<{ id: string; fullName: string }>,
): ArchivedSession[] {
  const names = new Map(projects.map((p) => [p.id, p.fullName]));
  return workspaces
    .filter((w) => (w.status === "archived" || w.status === "archiving") && w.kind !== "mission" && !w.parentMissionId)
    .map((w) => ({
      id: w.id,
      title: workspaceLabel(w),
      project: names.get(w.projectId) ?? "",
      branch: w.branch,
      archivedAt: w.updatedAt,
      saved: !(w.status === "archived" && w.errorMessage === ARCHIVED_UNSAVED),
      archiving: w.status === "archiving",
    }))
    .sort((a, b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt));
}

/** The sessions matching `query` by title, repository or branch. */
export function searchArchived(sessions: ArchivedSession[], query: string): ArchivedSession[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) => [s.title, s.project, s.branch].some((field) => field.toLowerCase().includes(q)));
}
