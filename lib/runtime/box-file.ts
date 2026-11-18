/**
 * Reading one file off a cloud session's box through the provider's exec:
 * where a path a reply names is on the box, and the command that prints the
 * file. The chat's images (app/api/workspaces/[id]/image) and its file
 * downloads (app/api/workspaces/[id]/download) read files this way. Imports
 * nothing, so the routes and the tests use it as is.
 */

/** The largest file read off a box: it crosses the provider's exec as text. */
export const BOX_FILE_MAX_BYTES = 6 * 1024 * 1024;

/**
 * Where `path` is on the box: as is when absolute, in the box user's home
 * when it starts `~/` (kept so, for {@link boxFileReadCommand} to find
 * there), else in the worktree. `..` never climbs above the root or the
 * home. Null for one no file can have (a NUL in it).
 */
export function boxFilePath(path: string, worktree: string): string | null {
  if (path.includes("\0")) return null;
  const home = path === "~" || path.startsWith("~/");
  const full = home ? path.slice(1) : path.startsWith("/") ? path : `${worktree}/${path}`;
  const parts: string[] = [];
  for (const part of full.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${home ? "~" : ""}/${parts.join("/")}`;
}

/** Exit codes of {@link boxFileReadCommand}, past the shell's own. */
export const BOX_FILE_MISSING = 3;
export const BOX_FILE_TOO_LARGE = 4;

/** What {@link boxFileReadCommand} puts around the file's base64, so whatever
 *  else lands in the output (a login shell's banner) is left out of it. */
const START = "<<outrunner-file>>";
const END = "<</outrunner-file>>";

/**
 * The command that prints the file at `path` on the box (as
 * {@link boxFilePath} gives it) as base64, between markers (read back with
 * {@link boxFileBase64}), or exits BOX_FILE_MISSING (no such readable
 * regular file) or BOX_FILE_TOO_LARGE (past BOX_FILE_MAX_BYTES). Its own
 * shell, as the box's exec isn't one, and quiet on stderr, which the
 * providers fold into the output. The read itself is bounded too, as the
 * file can grow after it's measured; a read that fails fails the command
 * (pipefail).
 */
export function boxFileReadCommand(path: string): string {
  const script = [
    "set -o pipefail",
    `f=${quote(path)}`,
    // `~/…` is the box user's home, which only the box knows.
    `case "$f" in "~/"*) f="$HOME/\${f#"~/"}" ;; esac`,
    `[ -f "$f" ] && [ -r "$f" ] || exit ${BOX_FILE_MISSING}`,
    `[ "$(wc -c < "$f" 2>/dev/null)" -le ${BOX_FILE_MAX_BYTES} ] || exit ${BOX_FILE_TOO_LARGE}`,
    `printf '%s' ${quote(START)}`,
    // Out before the closing marker, whose printf would exit 0 over it.
    `head -c ${BOX_FILE_MAX_BYTES + 1} "$f" 2>/dev/null | base64 | tr -d '\\n' || exit 1`,
    `printf '%s' ${quote(END)}`,
  ].join("; ");
  return `bash -c ${quote(script)}`;
}

/** The base64 {@link boxFileReadCommand} printed, or null for output it
 *  didn't print (no markers, or something not base64 between them). Past
 *  BOX_FILE_MAX_BYTES once decoded, the file grew as it was read. */
export function boxFileBase64(output: string): string | null {
  const start = output.indexOf(START);
  const end = output.indexOf(END, start + START.length);
  if (start < 0 || end < 0) return null;
  const payload = output.slice(start + START.length, end);
  return /^[A-Za-z0-9+/]*={0,2}$/.test(payload) ? payload : null;
}

/** Single-quoted for the shell. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The URL a file of `workspaceId`'s box downloads from. */
export function boxFileDownloadUrl(workspaceId: string, path: string): string {
  return `/api/workspaces/${workspaceId}/download?path=${encodeURIComponent(path)}`;
}
