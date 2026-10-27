import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getWorkspaceComputer, getWorkspace } from "@/lib/db/repositories";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";
import { reachableWorktree } from "@/lib/runtime/worktree-access";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The Files panel's reads. Without `?path=`, every file in the session's
 * worktree (tracked and untracked, not ignored). With `?path=`, that file's
 * text, bounded, or that it is binary. The path is checked for traversal and
 * links out of the worktree before anything is read. Cloud sessions on a
 * Runtime Computer only: a local one asks the agent on the Mac directly.
 */
export async function GET(request: Request, context: RouteContext) {
  if (!(await getOwner())) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  const resolution = resolveProvider(workspace);
  if (!resolution.ok) return providerErrorResponse(resolution);
  const provider = resolution.provider;
  if (!isComputerProvider(provider)) {
    return NextResponse.json({ error: "Browsing files needs a session on a cloud computer." }, { status: 409 });
  }

  const reach = reachableWorktree(await getWorkspaceComputer(workspace), workspace.worktreePath);
  if (!reach.ok) return NextResponse.json({ error: reach.error }, { status: 409 });

  const path = new URL(request.url).searchParams.get("path");
  try {
    if (path !== null) {
      return NextResponse.json(await provider.readWorkspaceFile(reach.sandboxId, reach.worktree, path));
    }
    return NextResponse.json(await provider.listWorkspaceFiles(reach.sandboxId, reach.worktree));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/Invalid file path/.test(message)) {
      return NextResponse.json({ error: "That isn't a file in this session." }, { status: 400 });
    }
    if (/not found in this workspace/.test(message)) {
      return NextResponse.json({ error: "This file isn't there any more." }, { status: 404 });
    }
    console.error(`Workspace ${id} files could not be read`, error);
    return NextResponse.json(
      { error: "Could not read this session's files. Check Outrunner's setup and try again." },
      { status: 500 },
    );
  }
}
