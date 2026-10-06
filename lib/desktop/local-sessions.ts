/**
 * How the sidebars show this Mac's local sessions: grouped under the folder
 * they work in, the way cloud workspaces sit under their repository. Pure, so
 * it can be tested without the Mac app.
 */

import type { LocalSession } from "@/lib/desktop/local-runtime";

export type LocalFolderGroup = {
  /** The folder's path: the group's identity and its tooltip. */
  folder: string;
  /** What the sidebar shows for the folder. */
  label: string;
  /** Newest first, as the agent lists them. */
  sessions: LocalSession[];
};

/** A session under its folder: what was asked, else its branch. */
export function localSessionLabel(session: LocalSession): string {
  return session.title || session.branch.replace(/^runtime\//, "") || session.name;
}

/**
 * Sessions grouped by folder, folders ordered by their newest session (the
 * agent lists sessions newest first). Two folders with the same name — two
 * clones called `app` — are told apart by their parent folder.
 */
export function groupLocalSessions(sessions: LocalSession[]): LocalFolderGroup[] {
  const byFolder = new Map<string, LocalSession[]>();
  for (const session of sessions) {
    const group = byFolder.get(session.folder);
    if (group) group.push(session);
    else byFolder.set(session.folder, [session]);
  }
  const names = [...byFolder.keys()].map((folder) => lastSegment(folder));
  return [...byFolder].map(([folder, group]) => {
    const name = lastSegment(folder);
    const shared = names.filter((other) => other === name).length > 1;
    return {
      folder,
      label: shared ? `${lastSegment(parentOf(folder))}/${name}` : name,
      sessions: group,
    };
  });
}

function lastSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function parentOf(path: string): string {
  return path.split("/").filter(Boolean).slice(0, -1).join("/");
}
