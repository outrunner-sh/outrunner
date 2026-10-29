/**
 * @ mentions in the composer: typing @ offers the session's files, its
 * changed ones first, narrowed by what follows the @ as a fuzzy match; the
 * pick goes into the text as `@path`, which the agent reads as the file's
 * path (Claude Code takes an @path in a prompt as a mention of the file). The
 * composer draws each mention as a pill (mentionSegments). Pure: the files
 * come from the session's agent (GET /workspaces/{id}/files).
 */

/** The @ being typed at the caret: where it starts, and what follows it. */
export type MentionQuery = { start: number; query: string };

/** The mention being typed where the caret is, if it is in one: an @ at the
 *  start of the text or after whitespace, then no space up to the caret. An
 *  email address's @ isn't one. */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2] };
}

/**
 * How well `path` matches `query`: its letters in order (a subsequence, any
 * case), scored higher for runs of them, for a start at a word's start, and
 * for falling in the file's own name; null where they aren't all there.
 */
export function fuzzyScore(path: string, query: string): number | null {
  if (!query) return 0;
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  const nameStart = p.lastIndexOf("/") + 1;
  let score = 0;
  let at = -1;
  let run = 0;
  for (const ch of q) {
    const next = p.indexOf(ch, at + 1);
    if (next < 0) return null;
    run = next === at + 1 ? run + 1 : 0;
    score += 1 + run * 2;
    if (next === 0 || "/._- ".includes(p[next - 1])) score += 3;
    if (next >= nameStart) score += 1;
    at = next;
  }
  // A shorter path for the same letters is the closer match.
  return score - path.length / 100;
}

/** The files to offer for `query`, best first, at most `limit`: with no query,
 *  the changed ones first then the rest as listed; with one, by fuzzy score,
 *  a changed file ahead of an equal one. */
export function matchFiles(files: string[], changed: number, query: string, limit = 8): string[] {
  if (!query) return files.slice(0, limit);
  const scored: { path: string; score: number }[] = [];
  files.forEach((path, i) => {
    const score = fuzzyScore(path, query);
    if (score !== null) scored.push({ path, score: score + (i < changed ? 2 : 0) });
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.path);
}

/** A path as a mention: `@path`, a space in it escaped as Claude Code reads
 *  one (2.1.304's mention pattern is `@((?:[^\s\\]|\\ )+)`, and `\ ` a
 *  space): `@docs/My\ Notes.md`. */
export function mentionOf(path: string): string {
  return `@${path.replace(/ /g, "\\ ")}`;
}

/** The text with the mention typed at `at` replaced by `@path ` and where the
 *  caret goes after it. */
export function insertMention(text: string, at: MentionQuery, caret: number, path: string): { text: string; caret: number } {
  const inserted = `${mentionOf(path)} `;
  const rest = text.slice(caret).replace(/^\S*/, "");
  return { text: text.slice(0, at.start) + inserted + rest.replace(/^ /, ""), caret: at.start + inserted.length };
}

/** The text in runs, each `@path` of a known file its own run, for the
 *  composer to draw them as pills behind the text. */
export function mentionSegments(text: string, known: ReadonlySet<string>): { text: string; mention: boolean }[] {
  const segments: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const match of text.matchAll(/(^|\s)(@((?:[^\s\\]|\\ )+))/g)) {
    const start = (match.index ?? 0) + match[1].length;
    if (!known.has(match[3].replace(/\\ /g, " "))) continue;
    if (start > last) segments.push({ text: text.slice(last, start), mention: false });
    segments.push({ text: match[2], mention: true });
    last = start + match[2].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), mention: false });
  return segments;
}

/** A listing of the changed files alone, from a change set (the shape of the
 *  agent's GET /workspaces/{id}/changes): what stands in for the session's
 *  files where they can't be listed (an agent, or a Mac app, from before the
 *  listing). Files deleted are left out: there's nothing to mention. */
export function changedOnly(files: { path: string; status: string }[]): { files: string[]; changed: number; truncated: true } {
  const changed = files.filter((f) => f.status !== "deleted").map((f) => f.path);
  return { files: changed, changed: changed.length, truncated: true };
}
