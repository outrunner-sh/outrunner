import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { deleteMedia, getOwnMedia, replaceMediaLink, setMediaAccess } from "@/lib/db/media";
import { isSameOriginRequest } from "@/lib/http/guards";
import { isUuid, mediaMarkdown, publicMediaPath } from "@/lib/media/media";
import { appUrl } from "@/lib/orgs/notify";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Delete a file a session uploaded: its public link stops working, and any
 * pull request showing it shows a broken image.
 *
 * Only its uploader can: {@link getOwnMedia} reads through the session
 * client, so RLS makes anyone else's file simply not exist.
 */
export async function DELETE(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to manage your media." }, { status: 401 });

  const { id } = await context.params;
  try {
    const media = isUuid(id) ? await getOwnMedia(id) : null;
    if (!media) return NextResponse.json({ error: "No such file." }, { status: 404 });
    await deleteMedia(media);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error(`Could not delete media ${id}`, error);
    return NextResponse.json({ error: "Couldn't delete that file. Try again." }, { status: 500 });
  }
}

/**
 * Change who a file's link opens for (`{ access: "public" | "private" }`),
 * or revoke the link and give the file a new one (`{ newLink: true }`):
 * every embed of the old link breaks, so it's for a link shared too widely.
 * Answers with the file's link and markdown as they are now.
 */
export async function PATCH(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to manage your media." }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { access?: unknown; newLink?: unknown } | null;
  const access = body?.access;
  if (access !== undefined && access !== "public" && access !== "private") {
    return NextResponse.json({ error: 'Access is "public" or "private".' }, { status: 400 });
  }
  if (access === undefined && body?.newLink !== true) {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  const { id } = await context.params;
  try {
    const media = isUuid(id) ? await getOwnMedia(id) : null;
    if (!media) return NextResponse.json({ error: "No such file." }, { status: 404 });
    if (access) await setMediaAccess(media.id, access);
    const publicId = body?.newLink === true ? await replaceMediaLink(media.id) : media.publicId;
    const url = appUrl(publicMediaPath(publicId, media.contentType), new URL(request.url).origin);
    return NextResponse.json({
      access: access ?? media.access,
      url,
      markdown: mediaMarkdown(media.name, url, media.contentType),
    });
  } catch (error) {
    console.error(`Could not change media ${id}`, error);
    return NextResponse.json({ error: "Couldn't change that file. Try again." }, { status: 500 });
  }
}
