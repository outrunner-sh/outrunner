import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getWorkspaceComputer, getWorkspace, readRuntimeComputerSecret } from "@/lib/db/repositories";
import { AgentClient, AgentRequestError } from "@/lib/runtime/agent-client";
import { type ComputerRuntimeProvider, isComputerProvider } from "@/lib/runtime/computer-provider";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";
import type { RuntimeComputer, Workspace } from "@/lib/runtime/types";
import { reachableWorktree } from "@/lib/runtime/worktree-access";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The Files panel's reads. Without `?path=`, every file in the session's
 * worktree (tracked and untracked, not ignored); a folder of checkouts lists
 * each one's under its folder. With `?path=`, that file's text, bounded, or
 * that it is binary. The path is checked for traversal and links out of the
 * worktree before anything is read. Cloud sessions on a Runtime Computer
 * only: a local one asks the agent on the Mac directly.
 */
export async function GET(request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) {
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

  const computer = await getWorkspaceComputer(workspace);
  const reach = reachableWorktree(computer, workspace.worktreePath);
  if (!reach.ok) return NextResponse.json({ error: reach.error }, { status: 409 });

  // An empty one lists, as the agent's own route does.
  const path = new URL(request.url).searchParams.get("path") || null;
  const fromAgent = computer && (await filesFromAgent(provider, computer, { workspace, userId: owner.id, path }));
  if (fromAgent) return fromAgent;
  try {
    if (path !== null) {
      return NextResponse.json(await provider.readWorkspaceFile(reach.sandboxId, reach.worktree, path));
    }
    const checkouts = workspace.checkouts?.map((c) => c.checkout);
    return NextResponse.json(await provider.listWorkspaceFiles(reach.sandboxId, reach.worktree, checkouts));
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

/**
 * The file list (or with `path`, one file) from the box's own agent: one
 * request, where reading it from here takes a round trip to the box per
 * command. Null where the agent can't answer it (one from before it could, or
 * a hiccup), for the caller to read it from here instead.
 */
async function filesFromAgent(
  provider: ComputerRuntimeProvider,
  computer: RuntimeComputer,
  { workspace, userId, path }: { workspace: Workspace; userId: string; path: string | null },
): Promise<NextResponse | null> {
  const secret = await readRuntimeComputerSecret(computer.id);
  if (!secret || !computer.daytonaSandboxId) return null;
  try {
    const agent = new AgentClient(await provider.agentTarget(computer.daytonaSandboxId, secret));
    const identity = { workspaceId: workspace.id, projectId: workspace.projectId, computerId: computer.id, userId };
    if (path === null) return NextResponse.json(await agent.listFiles(identity));
    return NextResponse.json(await agent.readFile(identity, path));
  } catch (error) {
    // Its answer about the path is the answer.
    if (error instanceof AgentRequestError && error.error?.code === "INVALID_REQUEST") {
      return NextResponse.json({ error: "That isn't a file in this session." }, { status: 400 });
    }
    if (error instanceof AgentRequestError && error.error?.code === "NOT_FOUND") {
      return NextResponse.json({ error: "This file isn't there any more." }, { status: 404 });
    }
    // No such route (an agent from before it) is expected; anything else is worth a line.
    if (!(error instanceof AgentRequestError && error.status === 404 && !error.error)) {
      console.warn(`Workspace ${workspace.id} files: the box's agent couldn't read them, reading them from here`, error);
    }
    return null;
  }
}
