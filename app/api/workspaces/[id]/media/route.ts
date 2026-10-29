import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { listSessionMedia } from "@/lib/db/media";
import { appUrl } from "@/lib/orgs/notify";
import { isUuid, mediaMarkdown, mediaPagePath, publicMediaPath } from "@/lib/media/media";

type RouteContext = { params: Promise<{ id: string }> };

/** The files a session's agent uploaded (its Environment panel's Media),
 *  newest first, each with the markdown that shows it. Only the session's
 *  owner sees them (RLS). */
export async function GET(request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to see this session's media." }, { status: 401 });

  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ media: [] });
  try {
    const origin = new URL(request.url).origin;
    const media = (await listSessionMedia(id)).map((m) => {
      const url = appUrl(publicMediaPath(m.publicId, m.contentType), origin);
      return {
        id: m.id,
        name: m.name,
        contentType: m.contentType,
        sizeBytes: m.sizeBytes,
        access: m.access,
        createdAt: m.createdAt,
        url,
        pageUrl: mediaPagePath(m.id),
        markdown: mediaMarkdown(m.name, url, m.contentType),
      };
    });
    return NextResponse.json({ media }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error(`Could not list media for session ${id}`, error);
    return NextResponse.json({ error: "Couldn't load this session's media." }, { status: 500 });
  }
}
