import { after, NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { attachmentImageBytes, cacheBoxImage, cachedBoxImage } from "@/lib/db/chat-images";
import { getWorkspace, getWorkspaceComputer } from "@/lib/db/repositories";
import { ATTACHMENT_DIR } from "@/lib/runtime/attachments";
import { boxImagePath, sniffImage } from "@/lib/runtime/chat-image";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";
import { reachableWorktree } from "@/lib/runtime/worktree-access";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * An image on a cloud session's box that Claude showed in a reply, or a file
 * a prompt attached (`?path=`, absolute or from the worktree), for the chat
 * to load. Only images, by their bytes' signature (not SVG, which can carry
 * script), and only up to BOX_IMAGE_MAX_BYTES. Read only, so no Origin
 * check: a GET carries the owner's cookie, and answers only them.
 *
 * It shows whether or not the box is up: an attached file comes from
 * storage, where it was uploaded; any other image is read off the box and a
 * copy kept (lib/db/chat-images.ts), which is served while the box is paused
 * or can't be read.
 */
export async function GET(request: Request, context: RouteContext) {
  if (!(await getOwner())) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });

  const resolution = resolveProvider(workspace);
  if (!resolution.ok) return providerErrorResponse(resolution);
  const provider = resolution.provider;
  if (!isComputerProvider(provider)) {
    return NextResponse.json({ error: "Only a cloud session's images can be shown." }, { status: 409 });
  }

  const asked = new URL(request.url).searchParams.get("path")?.trim();
  if (!asked) return NextResponse.json({ error: "Name an image." }, { status: 400 });
  // Where it is on the box, as far as the session's record says: a paused
  // box keeps its worktree, so the copy kept of one of its images is found.
  const worktree = workspace.worktreePath;
  const path = worktree || asked.startsWith("/") ? boxImagePath(asked, worktree ?? "/") : null;

  // A file a prompt attached: from storage, as uploaded. It never changes.
  const attached = path && worktree ? attachedName(path, worktree) : null;
  if (attached) {
    const bytes = await attachmentImageBytes(id, attached).catch((error: unknown) => {
      console.error(`Workspace ${id}: could not read attachment ${attached}`, error);
      return null;
    });
    if (bytes) return image(bytes, "private, max-age=31536000, immutable");
  }

  const reach = reachableWorktree(await getWorkspaceComputer(workspace), worktree);
  if (!reach.ok) return (path ? await kept(id, path) : null) ?? NextResponse.json({ error: reach.error }, { status: 409 });
  const onBox = boxImagePath(asked, reach.worktree);
  if (!onBox) return NextResponse.json({ error: "Name an image." }, { status: 400 });

  let bytes;
  try {
    bytes = await provider.readBoxImage(reach.sandboxId, onBox);
  } catch (error) {
    console.error(`Workspace ${id}: could not read image ${onBox}`, error);
    return (await kept(id, onBox)) ?? NextResponse.json({ error: "Couldn't read that image off the box." }, { status: 502 });
  }
  if (bytes === "missing") return NextResponse.json({ error: "No such image on the box." }, { status: 404 });
  if (bytes === "too-large") return NextResponse.json({ error: "That image is too large to show." }, { status: 413 });
  const type = sniffImage(bytes);
  if (!type) return NextResponse.json({ error: "That file isn't an image the chat shows." }, { status: 415 });

  // Kept for when the box is away, once the answer has gone: the chat
  // needn't wait on it, and after() sees it through where the server would
  // otherwise stop once it has answered.
  after(() =>
    cacheBoxImage(id, onBox, bytes, type).catch((error: unknown) =>
      console.error(`Workspace ${id}: could not keep a copy of image ${onBox}`, error),
    ),
  );
  // A file on the box can change (a screenshot taken again), so not for long.
  return image(bytes, "private, max-age=60");
}

/** The name in the worktree's `.attachments/` that `path` is, or null. */
function attachedName(path: string, worktree: string): string | null {
  const dir = `${boxImagePath(ATTACHMENT_DIR, worktree)}/`;
  if (!path.startsWith(dir)) return null;
  const name = path.slice(dir.length);
  return name && !name.includes("/") ? name : null;
}

/** The copy kept of the image at `path`, as a response; null for none. */
async function kept(workspaceId: string, path: string): Promise<NextResponse | null> {
  const bytes = await cachedBoxImage(workspaceId, path).catch(() => null);
  // Its age unknown, so the browser asks again soon: the box may be back.
  return bytes ? image(bytes, "private, max-age=10") : null;
}

/** Image bytes as the chat loads them; a 415 for bytes that aren't one. */
function image(bytes: Uint8Array, cacheControl: string): NextResponse {
  const type = sniffImage(bytes);
  if (!type) return NextResponse.json({ error: "That file isn't an image the chat shows." }, { status: 415 });
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": type,
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
