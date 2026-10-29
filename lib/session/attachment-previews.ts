/**
 * What this page already has of the files it attached: each one's name and
 * type and, for an image, an object URL of its own bytes, by attachment id.
 * The message a file went with shows it from here at once (the bubble as it
 * is sent, the prompt once Claude logs it, a new session's first prompt while
 * its box starts), with no round trip; what isn't here loads from the server.
 *
 * Module state rather than a component's: the composer that staged a file
 * is often gone (the new-session form navigates away as it sends) before the
 * message showing it renders. Kept for the page's life, the oldest let go
 * past MAX_PREVIEWS so a long session doesn't hold every screenshot.
 */

import { attachmentShortId, shortIdOfName } from "@/lib/runtime/attachments";

export type AttachmentPreview = {
  filename: string;
  contentType: string;
  /** Object URL of an image's bytes; null for any other file. */
  url: string | null;
};

const MAX_PREVIEWS = 60;

const previews = new Map<string, AttachmentPreview>();

/** Keep what's known of attachment `id`; its object URL is this module's to
 *  revoke from now on. */
export function keepPreview(id: string, preview: AttachmentPreview): void {
  previews.delete(id);
  previews.set(id, preview);
  while (previews.size > MAX_PREVIEWS) {
    const [oldest, kept] = previews.entries().next().value!;
    previews.delete(oldest);
    if (kept.url) URL.revokeObjectURL(kept.url);
  }
}

/** Let attachment `id` go: removed before it was sent. */
export function dropPreview(id: string): void {
  const kept = previews.get(id);
  previews.delete(id);
  if (kept?.url) URL.revokeObjectURL(kept.url);
}

export function previewOf(id: string): AttachmentPreview | null {
  return previews.get(id) ?? null;
}

/** The preview of the attachment a name on the box is (`.attachments/<short
 *  id>-<name>`), by the short id it leads with. */
export function previewOfName(name: string): AttachmentPreview | null {
  const short = shortIdOfName(name.split("/").pop() ?? name);
  if (!short) return null;
  for (const [id, preview] of previews) {
    if (attachmentShortId(id).toLowerCase() === short) return preview;
  }
  return null;
}
