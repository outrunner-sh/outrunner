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
 * clones called `app` — are told apart by as many parent folders as it takes.
 */
export function groupLocalSessions(sessions: LocalSession[]): LocalFolderGroup[] {
  const byFolder = new Map<string, LocalSession[]>();
  for (const session of sessions) {
    const group = byFolder.get(session.folder);
    if (group) group.push(session);
    else byFolder.set(session.folder, [session]);
  }
  const folders = [...byFolder.keys()];
  return [...byFolder].map(([folder, group]) => ({
    folder,
    label: distinctLabel(folder, folders),
    sessions: group,
  }));
}

/** The folder's name, with the fewest parent folders that set it apart from
 *  every other listed folder (`work/project/app` beside `home/project/app`). */
function distinctLabel(folder: string, folders: string[]): string {
  const parts = segments(folder);
  const tail = (path: string, depth: number) => segments(path).slice(-depth).join("/");
  for (let depth = 1; depth <= parts.length; depth++) {
    const label = tail(folder, depth);
    if (!folders.some((other) => other !== folder && tail(other, depth) === label)) return label;
  }
  return folder; // a whole path that ends another one (`/app` beside `/x/app`)
}

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}
