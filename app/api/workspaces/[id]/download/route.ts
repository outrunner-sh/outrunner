import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getWorkspace, getWorkspaceComputer } from "@/lib/db/repositories";
import { attachmentDisposition } from "@/lib/http/content-disposition";
import { BOX_FILE_MAX_BYTES, boxFilePath } from "@/lib/runtime/box-file";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";
import { reachableWorktree } from "@/lib/runtime/worktree-access";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A file on a cloud session's box (`?path=`: absolute, from `~/`, or from the
 * worktree), as a download: how a file the agent made reaches the user's
 * own computer, which the agent can't. A reply's link to a path comes here
 * (components/markdown.tsx). Its owner's alone, as any file on the box may
 * be asked for; up to BOX_FILE_MAX_BYTES, as it crosses the provider's exec.
 * Always a download, and inert if opened anyway. Read only, so no Origin
 * check: a GET carries the owner's cookie, and answers only them.
 */
export async function GET(request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace || workspace.ownerId !== owner.id) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  const resolution = resolveProvider(workspace);
  if (!resolution.ok) return providerErrorResponse(resolution);
  const provider = resolution.provider;
  if (!isComputerProvider(provider)) {
    return NextResponse.json({ error: "Only a cloud session's files can be downloaded." }, { status: 409 });
  }

  const asked = new URL(request.url).searchParams.get("path")?.trim();
  if (!asked) return NextResponse.json({ error: "Name a file." }, { status: 400 });
  const reach = reachableWorktree(await getWorkspaceComputer(workspace), workspace.worktreePath);
  if (!reach.ok) return NextResponse.json({ error: reach.error }, { status: 409 });
  const onBox = boxFilePath(asked, reach.worktree);
  if (!onBox) return NextResponse.json({ error: "Name a file." }, { status: 400 });

  let bytes;
  try {
    bytes = await provider.readBoxFile(reach.sandboxId, onBox);
  } catch (error) {
    console.error(`Workspace ${id}: could not read ${onBox} for a download`, error);
    return NextResponse.json({ error: "Couldn't read that file off the box. Try again." }, { status: 502 });
  }
  if (bytes === "missing") {
    return NextResponse.json({ error: `There's no ${onBox} on the box.` }, { status: 404 });
  }
  if (bytes === "too-large") {
    const mb = BOX_FILE_MAX_BYTES / 1024 / 1024;
    return NextResponse.json(
      { error: `That file is over ${mb} MB. Ask the agent to make a smaller one, or push it somewhere you can reach.` },
      { status: 413 },
    );
  }
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": attachmentDisposition(onBox),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
