/**
 * A Content-Disposition that saves the response as a file named `name` (its
 * last path segment, if it's a path): an ASCII fallback for the oldest
 * clients, and the name itself as RFC 6266's `filename*`, so `résumé.pdf`
 * or `shot 1.png` arrive as they are. Nothing in either can end the header
 * value, name a folder or hide the file.
 */
export function attachmentDisposition(name: string): string {
  const base = downloadName(name);
  const ascii = base.replace(/[^\w.() -]/g, "_");
  const encoded = encodeURIComponent(base).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** The name a file at `path` downloads as: its last segment, not hidden (a
 *  leading dot would save it out of sight). The chat names a download it
 *  saves itself the same. */
export function downloadName(path: string): string {
  return path.split("/").pop()?.trim().replace(/^\.+/, "") || "file";
}
