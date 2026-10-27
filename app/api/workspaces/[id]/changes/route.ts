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
 * Without `?path=`, list the active worktree's changed files. With `?path=`,
 * return a bounded, text-only diff for that one file. The provider validates
 * membership, rejects traversal and Git pathspec magic, and caps the size.
 * Both are measured from the workspace's base branch, so changes it has
 * already committed or pushed still show.
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

  const path = new URL(request.url).searchParams.get("path");

  try {
    if (isComputerProvider(provider)) {
      const computer = await getWorkspaceComputer(workspace);
      const reach = reachableWorktree(computer, workspace.worktreePath);
      if (!reach.ok) return NextResponse.json({ error: reach.error }, { status: 409 });
      const fromAgent = computer && (await changesFromAgent(provider, computer, { workspace, userId: owner.id, path }));
      if (fromAgent) return fromAgent;
      // A folder of checkouts is no repository for git from outside: only
      // the agent reads it.
      if (workspace.checkouts) {
        return NextResponse.json(
          { error: "Couldn't read this session's changes from its box. Try again in a moment." },
          { status: 503 },
        );
      }
      if (path !== null) {
        const diff = await provider.readWorkspaceChangedFileDiff(
          reach.sandboxId,
          reach.worktree,
          path,
          workspace.baseBranch,
        );
        return NextResponse.json({ diff });
      }
      const files = await provider.listWorkspaceChangedFiles(
        reach.sandboxId,
        reach.worktree,
        workspace.baseBranch,
      );
      return NextResponse.json({ files });
    }

    if (!workspace.sandboxId) {
      return NextResponse.json(
        { error: "Resume the workspace to view its changes." },
        { status: 409 },
      );
    }
    if (path !== null) {
      const diff = await provider.readChangedFileDiff({
        workspaceId: workspace.id,
        sandboxId: workspace.sandboxId,
        path,
        baseBranch: workspace.baseBranch,
      });
      return NextResponse.json({ diff });
    }
    const files = await provider.listChangedFiles({
      workspaceId: workspace.id,
      sandboxId: workspace.sandboxId,
      baseBranch: workspace.baseBranch,
    });
    return NextResponse.json({ files });
  } catch (error) {
    console.error(`Workspace ${id} changes could not be read`, error);
    const message = error instanceof Error ? error.message : "";
    if (/not part of|Invalid changed file path/i.test(message)) {
      return NextResponse.json(
        { error: "That file is not part of this workspace's changes." },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "Could not read workspace changes. Check Outrunner's setup and try again." },
      { status: 500 },
    );
  }
}

/**
 * The change set (or with `path`, one file's diff) from the box's own agent,
 * which runs git beside the worktree: one request, where reading it from here
 * takes a round trip to the box per git command, too slow for the panel to
 * keep up as Claude edits. Null where the agent can't answer it (one from
 * before it could, or a hiccup), for the caller to read it from here as before.
 */
async function changesFromAgent(
  provider: ComputerRuntimeProvider,
  computer: RuntimeComputer,
  { workspace, userId, path }: { workspace: Workspace; userId: string; path: string | null },
): Promise<NextResponse | null> {
  const secret = await readRuntimeComputerSecret(computer.id);
  if (!secret || !computer.daytonaSandboxId) return null;
  try {
    const agent = new AgentClient(await provider.agentTarget(computer.daytonaSandboxId, secret));
    const identity = { workspaceId: workspace.id, projectId: workspace.projectId, computerId: computer.id, userId };
    if (path === null) return NextResponse.json({ files: await agent.listChanges(identity) });
    return NextResponse.json({ diff: await agent.changedFileDiff(identity, path) });
  } catch (error) {
    // Its answer that the path isn't one of the changes is the answer.
    if (error instanceof AgentRequestError && (error.error?.code === "INVALID_REQUEST" || error.error?.code === "NOT_FOUND")) {
      return NextResponse.json({ error: "That file is not part of this workspace's changes." }, { status: 400 });
    }
    // No such route (an agent from before it) is expected; anything else is worth a line.
    if (!(error instanceof AgentRequestError && error.status === 404 && !error.error)) {
      console.warn(`Workspace ${workspace.id} changes: the box's agent couldn't read them, reading them from here`, error);
    }
    return null;
  }
}
