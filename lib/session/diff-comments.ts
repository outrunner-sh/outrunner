/**
 * Comments on the session's diff: lines picked in the Changes view, each with
 * a note, held until the user's next message and sent with it as quotes the
 * agent can find in the file (path, line range, the code itself). Kept for the
 * tab (sessionStorage) like the prompt queue, so a reload doesn't lose a
 * review half written; the Changes view and the composer read the same list
 * and hear of each other's changes (subscribeComments).
 */

import type { DiffLine } from "@/lib/runtime/diff";

/** One comment on a range of lines. `side` says which file the numbers are
 *  in: the new one, or the old one for lines the change removed. */
export type DiffComment = {
  id: string;
  path: string;
  side: "new" | "old";
  startLine: number;
  endLine: number;
  code: string;
  comment: string;
};

/** Lines picked in a diff, ready to be commented on. */
export type DiffSelection = Pick<DiffComment, "side" | "startLine" | "endLine" | "code">;

/** A comment as a sent prompt carries it: everything but the id. */
export type CommentQuote = Omit<DiffComment, "id">;

/** Where the comments are kept: sessionStorage, or a stand-in in tests. */
export type CommentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const key = (workspaceId: string) => `outrunner:diff-comments:${workspaceId}`;

function isDiffComment(value: unknown): value is DiffComment {
  if (!value || typeof value !== "object") return false;
  const { id, path, side, startLine, endLine, code, comment } = value as Record<string, unknown>;
  return (
    typeof id === "string" &&
    typeof path === "string" &&
    path !== "" &&
    (side === "new" || side === "old") &&
    Number.isInteger(startLine) &&
    Number.isInteger(endLine) &&
    (startLine as number) > 0 &&
    (endLine as number) >= (startLine as number) &&
    typeof code === "string" &&
    typeof comment === "string" &&
    comment.trim() !== ""
  );
}

// The last list read for each key, by the text it was read from: the same
// text gives back the same array, so React can take it as a snapshot
// (useSyncExternalStore) without re-rendering for nothing.
const lastRead = new Map<string, { raw: string | null; comments: DiffComment[] }>();
const NONE: DiffComment[] = [];

/** The session's comments as this tab kept them; empty where there are none,
 *  or none that can be read (what can't be is dropped, not sent). */
export function readComments(storage: CommentStorage | null, workspaceId: string): DiffComment[] {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(key(workspaceId)) ?? null;
  } catch {
    return NONE;
  }
  if (!raw) return NONE;
  const last = lastRead.get(key(workspaceId));
  if (last && last.raw === raw) return last.comments;
  let comments = NONE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) comments = parsed.filter(isDiffComment);
  } catch {
    // Not JSON: as if there were none.
  }
  lastRead.set(key(workspaceId), { raw, comments });
  return comments;
}

const listeners = new Map<string, Set<() => void>>();

/** Hear of every change to the session's comments, from anywhere in the page.
 *  Returns the way to stop. */
export function subscribeComments(workspaceId: string, listener: () => void): () => void {
  const set = listeners.get(workspaceId) ?? new Set();
  set.add(listener);
  listeners.set(workspaceId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(workspaceId);
  };
}

/** Keep `comments` for the tab (an empty list is forgotten), and tell everyone
 *  listening. */
function writeComments(storage: CommentStorage | null, workspaceId: string, comments: DiffComment[]): void {
  try {
    if (comments.length > 0) storage?.setItem(key(workspaceId), JSON.stringify(comments));
    else storage?.removeItem(key(workspaceId));
  } catch {
    // Storage full or blocked: nothing is kept, and the listeners read that.
  }
  for (const listener of listeners.get(workspaceId) ?? []) listener();
}

/** Add a comment to the session's list, after the others. Returns it, id and all. */
export function addComment(
  storage: CommentStorage | null,
  workspaceId: string,
  comment: CommentQuote,
): DiffComment {
  const added = { ...comment, id: crypto.randomUUID() };
  writeComments(storage, workspaceId, [...readComments(storage, workspaceId), added]);
  return added;
}

/** Take one comment off the session's list. */
export function removeComment(storage: CommentStorage | null, workspaceId: string, id: string): void {
  clearComments(storage, workspaceId, [id]);
}

/** Take the comments a message carried off the list: exactly those, so one
 *  written while it was on its way stays for the next. */
export function clearComments(storage: CommentStorage | null, workspaceId: string, ids: string[]): void {
  const current = readComments(storage, workspaceId);
  const kept = current.filter((c) => !ids.includes(c.id));
  if (kept.length !== current.length) writeComments(storage, workspaceId, kept);
}

/**
 * Lines `from` to `to` (indices into `lines`, either way round) as a
 * selection to comment on, or null where they hold no code (hunk headers and
 * file notices alone). Numbered in the new file wherever the range has a line
 * that is in it; only a range of removed lines alone is numbered in the old
 * one. The code is the lines the numbers name, without their +/- marks: on
 * the new side, a removed line between them isn't in the file at those
 * numbers, so it isn't quoted as if it were.
 */
export function selectionFromLines(lines: DiffLine[], from: number, to: number): DiffSelection | null {
  const picked = lines.slice(Math.min(from, to), Math.max(from, to) + 1);
  const isNew = picked.some((l) => (l.type === "add" || l.type === "context") && l.newNumber !== undefined);
  const side = isNew ? "new" : "old";
  const quoted = picked.filter((l) =>
    isNew ? l.type === "add" || l.type === "context" : l.type === "del",
  );
  const numbers = quoted
    .map((l) => (isNew ? l.newNumber : l.oldNumber))
    .filter((n): n is number => n !== undefined);
  if (numbers.length === 0) return null;
  return {
    side,
    startLine: Math.min(...numbers),
    endLine: Math.max(...numbers),
    code: quoted.map((l) => l.text).join("\n"),
  };
}

/** "12" for one line, "12-18" for a range: as a quote names its lines. */
export function lineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
}

const HEADING = "Comments on the diff:";

// Fence languages for the common extensions; anything else gets a plain fence.
const LANGUAGES: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
  py: "python", go: "go", rs: "rust", rb: "ruby", java: "java", kt: "kotlin",
  swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", sh: "bash", bash: "bash", zsh: "bash", sql: "sql",
  css: "css", scss: "scss", html: "html", vue: "vue", svelte: "svelte",
  json: "json", yml: "yaml", yaml: "yaml", toml: "toml", md: "markdown", xml: "xml",
};

function fenceLanguage(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? "") : "";
}

// Paths go in a quoted attribute; the few characters that would end it early
// are escaped, and read back by parseCommentQuotes.
const escapeAttr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const unescapeAttr = (value: string) => value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function quoteBlock(c: CommentQuote): string {
  // A fence longer than any run of backticks in the code, so code that has a
  // fence of its own (a markdown file) can't close the quote early.
  const longest = Math.max(0, ...Array.from(c.code.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const side = c.side === "old" ? ' side="old"' : "";
  return [
    `<comment file="${escapeAttr(c.path)}" lines="${lineRange(c.startLine, c.endLine)}"${side}>`,
    `${fence}${fenceLanguage(c.path)}`,
    c.code,
    fence,
    c.comment.trim(),
    "</comment>",
  ].join("\n");
}

/**
 * The prompt as it is sent with comments on the diff: the user's words, then
 * each comment as a `<comment file lines>` block quoting its code, so the
 * agent knows exactly which lines are meant. A removed range says so
 * (`side="old"`: the numbers are the old file's). No comments, no change.
 */
export function withComments(text: string, comments: CommentQuote[]): string {
  if (comments.length === 0) return text;
  const quotes = [HEADING, ...comments.map(quoteBlock)].join("\n\n");
  return text.trim() ? `${text}\n\n${quotes}` : quotes;
}

const BLOCK =
  /^<comment file="([^"]*)" lines="(\d+)(?:-(\d+))?"( side="old")?>\n(`{3,})[^\n`]*\n([\s\S]*?)\n?\5\n([\s\S]*?)\n<\/comment>\s*/;

/**
 * A sent prompt read back into the user's words and the comments it carried
 * (withComments), so the conversation shows them as quotes rather than as the
 * blocks the agent reads. A prompt that doesn't end in comments exactly as
 * withComments writes them is all words: nothing the user typed is hidden.
 */
export function parseCommentQuotes(text: string): { text: string; quotes: CommentQuote[] } {
  // The heading could be in the user's words too, or in a comment: the first
  // one followed by nothing but comments is the one withComments wrote.
  for (let at = text.indexOf(HEADING); at !== -1; at = text.indexOf(HEADING, at + 1)) {
    if (at > 0 && !text.slice(0, at).endsWith("\n\n")) continue;
    const quotes = readQuotes(text.slice(at + HEADING.length));
    if (quotes) return { text: text.slice(0, at).trimEnd(), quotes };
  }
  return { text, quotes: [] };
}

/** The comment blocks after the heading, or null unless that is all there is. */
function readQuotes(after: string): CommentQuote[] | null {
  let rest = after.replace(/^\s+/, "");
  const quotes: CommentQuote[] = [];
  while (rest !== "") {
    const match = BLOCK.exec(rest);
    if (!match) return null;
    const startLine = Number(match[2]);
    quotes.push({
      path: unescapeAttr(match[1]),
      side: match[4] ? "old" : "new",
      startLine,
      endLine: match[3] ? Number(match[3]) : startLine,
      code: match[6],
      comment: match[7],
    });
    rest = rest.slice(match[0].length);
  }
  return quotes.length > 0 ? quotes : null;
}
