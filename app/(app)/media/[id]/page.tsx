import { notFound, redirect } from "next/navigation";

import { MediaView } from "@/components/media-view";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getOwnMedia } from "@/lib/db/media";
import { isUuid, mediaMarkdown, publicMediaPath } from "@/lib/media/media";
import { appUrl } from "@/lib/orgs/notify";

/**
 * A file a session's agent uploaded, for the person whose session it was:
 * see it, copy its link or markdown, choose who its link opens for, replace
 * the link, delete it. Anyone else gets a 404 (RLS),
 * as for a file that never was; its public link is app/m/[file].
 */
export default async function MediaPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await getOwnerSafe())) redirect("/signin");
  const { id } = await params;
  const media = isUuid(id) ? await getOwnMedia(id) : null;
  if (!media) notFound();

  const url = appUrl(publicMediaPath(media.publicId, media.contentType));
  return (
    <MediaView
      media={{
        id: media.id,
        name: media.name,
        contentType: media.contentType,
        sizeBytes: media.sizeBytes,
        access: media.access,
        createdAt: media.createdAt,
        workspaceId: media.workspaceId,
        url,
        markdown: mediaMarkdown(media.name, url, media.contentType),
      }}
    />
  );
}
