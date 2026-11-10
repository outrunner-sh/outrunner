import type { Workspace } from "@/lib/runtime/types";

/** Room for a sentence in the sidebar; the column allows 200. */
export const TITLE_MAX = 80;

/**
 * A session's title from the first thing the user asked: its first non-empty
 * line, whitespace collapsed, cut at a word boundary to TITLE_MAX with an
 * ellipsis. Null when there is no text (a prompt of only attachments), so the
 * next prompt gets the chance instead.
 */
export function sessionTitle(prompt: string): string | null {
  const line = prompt
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  // A word boundary, unless that would throw away most of the line.
  const head = space >= TITLE_MAX / 2 ? cut.slice(0, space) : cut;
  return `${head.trimEnd()}…`;
}

/** The title to give a session from a prompt: none when it already has one
 *  (the first prompt names it for good) or the prompt has no text. */
export function titleToSet(workspace: { title: string | null }, prompt: string): string | null {
  return workspace.title ? null : sessionTitle(prompt);
}

/** What to call a cloud session: its title, else its branch without the
 *  generated `runtime/` prefix. */
export function workspaceLabel(workspace: Pick<Workspace, "title" | "branch">): string {
  return workspace.title || workspace.branch.replace(/^runtime\//, "");
}

/** A title the user typed to rename a session, made one line and trimmed;
 *  null when nothing's left or it's longer than TITLE_MAX. */
export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const title = raw.replace(/\s+/g, " ").trim();
  return title && title.length <= TITLE_MAX ? title : null;
}

/** Why a typed title can't be saved, to say under the field; null when it
 *  can, or is empty (Rename is just disabled). An automation's titles run
 *  longer than TITLE_MAX, so renaming one can open over the limit. */
export function titleProblem(raw: string): string | null {
  const length = raw.replace(/\s+/g, " ").trim().length;
  return length > TITLE_MAX ? `Up to ${TITLE_MAX} characters (this is ${length}).` : null;
}
