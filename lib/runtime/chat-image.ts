/**
 * Images Claude points at in its replies (`![File tree](.context/tree.png)`),
 * which live on the session's box, where the browser can't reach them: the
 * chat loads them through /api/workspaces/[id]/image, which reads them off the
 * box. (Not the box's Docker image: that's lib/runtime/box-image.ts.) Imports
 * nothing, so the browser, the route and the tests use it as is.
 */

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

/** The URL the chat loads a box image of `workspaceId` at. */
export function boxImageUrl(workspaceId: string, path: string): string {
  return `/api/workspaces/${workspaceId}/image?path=${encodeURIComponent(path)}`;
}
