/**
 * A session's artifacts (GET /workspaces/{id}/artifacts), the part with no
 * network: the screenshots and recordings its agent uploaded from its box
 * (docs/media.md), as the API shows them. lib/api/artifacts.deps.ts reads
 * them, and signs a download.
 */

import type { Media } from "@/lib/db/media";
import { mediaMarkdown, publicMediaPath } from "@/lib/media/media";

/** How long a download link lasts. */
export const DOWNLOAD_SECONDS = 15 * 60;

/** A file as the API shows it: its link (anyone's when it's public, else its
 *  uploader's, signed in), and the line that shows it in a pull request. */
export function artifactJson(media: Media, base: string): Record<string, unknown> {
  const url = new URL(publicMediaPath(media.publicId, media.contentType), base).toString();
  return {
    id: media.id,
    name: media.name,
    content_type: media.contentType,
    size_bytes: media.sizeBytes,
    access: media.access,
    url,
    markdown: mediaMarkdown(media.name, url, media.contentType),
    created_at: media.createdAt,
  };
}
