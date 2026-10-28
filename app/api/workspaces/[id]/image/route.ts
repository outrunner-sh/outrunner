import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getWorkspace, getWorkspaceComputer } from "@/lib/db/repositories";
import { boxImagePath, sniffImage } from "@/lib/runtime/chat-image";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";
import { reachableWorktree } from "@/lib/runtime/worktree-access";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * An image on a cloud session's box that Claude showed in a reply
 * (`?path=`, absolute or from the worktree), for the chat to load. Only
 * images, by their bytes' signature (not SVG, which can carry script), and
 * only up to BOX_IMAGE_MAX_BYTES. Read only, so no Origin check: a GET carries
 * the owner's cookie, and answers only them.
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
  const reach = reachableWorktree(await getWorkspaceComputer(workspace), workspace.worktreePath);
  if (!reach.ok) return NextResponse.json({ error: reach.error }, { status: 409 });

  const asked = new URL(request.url).searchParams.get("path")?.trim();
  const path = asked ? boxImagePath(asked, reach.worktree) : null;
  if (!path) return NextResponse.json({ error: "Name an image." }, { status: 400 });

  let bytes;
  try {
    bytes = await provider.readBoxImage(reach.sandboxId, path);
  } catch (error) {
    console.error(`Workspace ${id}: could not read image ${path}`, error);
    return NextResponse.json({ error: "Couldn't read that image off the box." }, { status: 502 });
  }
  if (bytes === "missing") return NextResponse.json({ error: "No such image on the box." }, { status: 404 });
  if (bytes === "too-large") return NextResponse.json({ error: "That image is too large to show." }, { status: 413 });
  const type = sniffImage(bytes);
  if (!type) return NextResponse.json({ error: "That file isn't an image the chat shows." }, { status: 415 });

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": type,
      // A file on the box can change (a screenshot taken again), so not for long.
      "Cache-Control": "private, max-age=60",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
