/**
 * Images Claude points at in its replies (`![File tree](.context/tree.png)`),
 * which live on the session's box, where the browser can't reach them: the
 * chat loads them through /api/workspaces/[id]/image, which reads them off the
 * box. (Not the box's Docker image: that's lib/runtime/box-image.ts.) Imports
 * nothing, so the browser, the route and the tests use it as is.
 */

/** The largest image read off a box: it crosses the provider's exec as text. */
export const BOX_IMAGE_MAX_BYTES = 6 * 1024 * 1024;

/**
 * The path on the box a markdown image's `src` names, or null for one the
 * browser loads by itself (http:, https:, data:, blob: and any other scheme).
 * `file://` paths count as paths. As a URL's: what follows an unescaped `?`
 * or `#` isn't the file's name, and percent-escapes (`%20`, `%23`) are.
 */
export function localImagePath(src: string | undefined): string | null {
  const raw = src?.trim();
  if (!raw) return null;
  const path = raw.startsWith("file://") ? raw.slice("file://".length) : raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) return null;
  const file = path.replace(/[?#].*$/, "");
  try {
    return decodeURIComponent(file) || null;
  } catch {
    return file || null;
  }
}

/** Where `path` is on the box: as is when absolute, else in the worktree. Null
 *  for one no file can have (a NUL in it). */
export function boxImagePath(path: string, worktree: string): string | null {
  if (path.includes("\0")) return null;
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path : `${worktree}/${path}`).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** The image type `bytes` are, by their signature; null for anything else.
 *  SVG never counts: it can carry script. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  // RIFF....WEBP
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

/** Exit codes of {@link imageReadCommand}, past the shell's own. */
export const IMAGE_MISSING = 3;
export const IMAGE_TOO_LARGE = 4;

/** What {@link imageReadCommand} puts around the image's base64, so whatever
 *  else lands in the output (a login shell's banner) is left out of it. */
const START = "<<outrunner-image>>";
const END = "<</outrunner-image>>";

/**
 * The command that prints the file at `path` on the box as base64, between
 * markers (read back with {@link imageBase64}), or exits IMAGE_MISSING
 * (no such readable regular file) or IMAGE_TOO_LARGE (past
 * BOX_IMAGE_MAX_BYTES). Its own shell, as the box's exec isn't one, and quiet
 * on stderr, which the providers fold into the output. The read itself is
 * bounded too, as the file can grow after it's measured; a read that fails
 * fails the command (pipefail).
 */
export function imageReadCommand(path: string): string {
  const script = [
    "set -o pipefail",
    `f=${quote(path)}`,
    `[ -f "$f" ] && [ -r "$f" ] || exit ${IMAGE_MISSING}`,
    `[ "$(wc -c < "$f" 2>/dev/null)" -le ${BOX_IMAGE_MAX_BYTES} ] || exit ${IMAGE_TOO_LARGE}`,
    `printf '%s' ${quote(START)}`,
    // Out before the closing marker, whose printf would exit 0 over it.
    `head -c ${BOX_IMAGE_MAX_BYTES + 1} "$f" 2>/dev/null | base64 | tr -d '\\n' || exit 1`,
    `printf '%s' ${quote(END)}`,
  ].join("; ");
  return `bash -c ${quote(script)}`;
}

/** The base64 {@link imageReadCommand} printed, or null for output it
 *  didn't print (no markers, or something not base64 between them). Past
 *  BOX_IMAGE_MAX_BYTES once decoded, the file grew as it was read. */
export function imageBase64(output: string): string | null {
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

/** The URL the chat loads a box image of `workspaceId` at. */
export function boxImageUrl(workspaceId: string, path: string): string {
  return `/api/workspaces/${workspaceId}/image?path=${encodeURIComponent(path)}`;
}
