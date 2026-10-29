import { getOwnerSafe } from "@/lib/auth/owner";
import { getPublicMedia, signedMediaUrl } from "@/lib/db/media";
import { publicIdFromFile } from "@/lib/media/media";

/**
 * A file's link, `/m/{publicId}.{ext}`: what a pull request's `![name](url)`
 * shows. A public file opens for anyone with the link, GitHub's image proxy
 * among them, signed out; the id is 32 random bytes, so nobody finds a file
 * without being given its link. A private one (a video, unless uploaded as
 * public) opens only for its uploader, signed in, and is a 404 to anyone
 * else. It works until its uploader deletes the file or replaces its link.
 *
 * The bytes stream from the private bucket through a URL signed for this
 * read, with a range passed on, so a video seeks. Served only as the image
 * or video type checked when it was uploaded, with nosniff and a sandbox, so
 * nothing in a file runs on the app's origin.
 */
async function serve(request: Request, params: Promise<{ file: string }>, head: boolean): Promise<Response> {
  const publicId = publicIdFromFile((await params).file);
  const media = publicId ? await getPublicMedia(publicId).catch(() => null) : null;
  const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  if (!media) return notFound();
  if (media.access === "private" && (await getOwnerSafe())?.id !== media.ownerId) return notFound();

  const range = request.headers.get("range");
  let upstream: Response;
  try {
    upstream = await fetch(await signedMediaUrl(media.storagePath), {
      method: head ? "HEAD" : "GET",
      headers: range ? { range } : {},
    });
  } catch (error) {
    console.error(`Media ${media.id}: couldn't read its bytes`, error);
    return new Response("Try again", { status: 502 });
  }
  if (!upstream.ok) {
    if (upstream.status === 416) return new Response(null, { status: 416, headers: passOn(upstream, ["content-range"]) });
    console.error(`Media ${media.id}: storage answered ${upstream.status}`);
    return new Response("Try again", { status: 502 });
  }

  const headers = passOn(upstream, ["content-length", "content-range", "etag", "last-modified"]);
  headers.set("content-type", media.contentType);
  headers.set("accept-ranges", "bytes");
  // A deleted file stops being served within the hour; GitHub's proxy keeps
  // its own copy by its own rules. A private one is never kept on the way.
  headers.set("cache-control", media.access === "public" ? "public, max-age=3600" : "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  headers.set("cross-origin-resource-policy", "cross-origin");
  headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(media.name)}`);
  return new Response(head ? null : upstream.body, { status: upstream.status, headers });
}

function passOn(upstream: Response, names: string[]): Headers {
  const headers = new Headers();
  for (const name of names) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export async function GET(request: Request, { params }: { params: Promise<{ file: string }> }) {
  return serve(request, params, false);
}

export async function HEAD(request: Request, { params }: { params: Promise<{ file: string }> }) {
  return serve(request, params, true);
}
