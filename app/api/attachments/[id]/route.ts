import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { deleteAttachment, getAttachments, readAttachmentBytes } from "@/lib/db/attachments";
import { isSameOriginRequest } from "@/lib/http/guards";
import { sniffImage } from "@/lib/runtime/chat-image";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * One of the owner's attachments, when it's an image, for its thumbnail: a
 * new session's first prompt shows its files while the box starts, from
 * here once a reload has let the page's own copies go. Only images, by their
 * bytes' signature, as the chat's image route; anything else is a 415, and
 * shown by name. Read only, so no Origin check; RLS answers only the owner.
 */
export async function GET(_request: Request, context: RouteContext) {
  if (!(await getOwner())) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const { id } = await context.params;
  let bytes: Buffer;
  try {
    const [attachment] = await getAttachments([id]);
    if (!attachment) return NextResponse.json({ error: "No such attachment." }, { status: 404 });
    bytes = await readAttachmentBytes(attachment.storagePath);
  } catch (error) {
    console.error(`Could not read attachment ${id}`, error);
    return NextResponse.json({ error: "Couldn't read that attachment." }, { status: 502 });
  }
  const type = sniffImage(bytes);
  if (!type) return NextResponse.json({ error: "That attachment isn't an image." }, { status: 415 });
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": type,
      // An attachment never changes.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

/**
 * Remove an attachment the user took off the composer before sending.
 *
 * No ownership check here: {@link deleteAttachment} reads the row through the
 * session client first, so RLS makes another owner's id simply not exist.
 */
export async function DELETE(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to manage attachments." }, { status: 401 });
  }

  const { id } = await context.params;
  try {
    await deleteAttachment(id);
    return NextResponse.json({ removed: true });
  } catch (error) {
    console.error(`Could not remove attachment ${id}`, error);
    return NextResponse.json(
      { error: "Could not remove that file. Please try again." },
      { status: 500 },
    );
  }
}
