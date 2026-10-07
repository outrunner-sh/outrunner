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

/** What to call a cloud session: its title, else its branch without the
 *  generated `runtime/` prefix. */
export function workspaceLabel(workspace: Pick<Workspace, "title" | "branch">): string {
  return workspace.title || workspace.branch.replace(/^runtime\//, "");
}
