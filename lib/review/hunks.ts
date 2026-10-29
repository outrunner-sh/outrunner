/**
 * A pull request's changed files as the Review tab shows them: each file's
 * patch (GitHub's, one file's unified diff without its headers) cut into its
 * hunks. A hunk is the unit a reviewer reads, and has an id that stays put
 * across reads of the same PR (its file and place in it), so a tour step or a
 * picked line can point at one.
 *
 * Pure (no I/O), so it is unit-tested in Node.
 */

import { parseUnifiedDiff, type DiffLine } from "@/lib/runtime/diff";
import { lineKind, type LineKind } from "@/lib/review/line-kinds";

/** One changed file of a pull request. `patch` is null for a binary file or
 *  one GitHub thought too large to show. */
export type PullFile = {
  path: string;
  /** What it was called before, for a rename. */
  previousPath: string | null;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  kind: LineKind;
  patch: string | null;
};

export type Hunk = {
  /** `path#index`: the file, and the hunk's place in it from 0. */
  id: string;
  path: string;
  index: number;
  /** The `@@ -a,b +c,d @@ …` line. */
  header: string;
  /** Its body: added, removed and unchanged lines, with their numbers. */
  lines: DiffLine[];
};

export const hunkId = (path: string, index: number) => `${path}#${index}`;

/** A file's patch, cut into hunks. Lines before the first hunk header (there
 *  are none in GitHub's patches) are left out. */
export function splitHunks(path: string, patch: string | null): Hunk[] {
  if (!patch) return [];
  const hunks: Hunk[] = [];
  for (const line of parseUnifiedDiff(patch, { headerless: true })) {
    if (line.type === "hunk") {
      hunks.push({ id: hunkId(path, hunks.length), path, index: hunks.length, header: line.text, lines: [] });
    } else if (hunks.length > 0 && line.type !== "meta") {
      hunks.at(-1)!.lines.push(line);
    } else if (hunks.length > 0 && line.text.startsWith("\\")) {
      // "\ No newline at end of file" belongs to the hunk it ends.
      hunks.at(-1)!.lines.push(line);
    }
  }
  return hunks;
}

type GitHubFile = {
  filename?: unknown;
  previous_filename?: unknown;
  status?: unknown;
  additions?: unknown;
  deletions?: unknown;
  patch?: unknown;
};

const STATUSES = new Set<PullFile["status"]>(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]);

/** GitHub's `/pulls/{n}/files` records as PullFiles; one without a name is
 *  dropped. */
export function toPullFiles(records: readonly unknown[]): PullFile[] {
  const files: PullFile[] = [];
  for (const record of records) {
    const f = (record ?? {}) as GitHubFile;
    if (typeof f.filename !== "string" || !f.filename) continue;
    const status = STATUSES.has(f.status as PullFile["status"]) ? (f.status as PullFile["status"]) : "modified";
    files.push({
      path: f.filename,
      previousPath: typeof f.previous_filename === "string" ? f.previous_filename : null,
      status,
      additions: typeof f.additions === "number" ? f.additions : 0,
      deletions: typeof f.deletions === "number" ? f.deletions : 0,
      kind: lineKind(f.filename),
      patch: typeof f.patch === "string" ? f.patch : null,
    });
  }
  return files;
}
