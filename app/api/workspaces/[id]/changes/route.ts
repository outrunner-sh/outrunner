import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getWorkspaceComputer, getWorkspace } from "@/lib/db/repositories";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";
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
    if (isComputerProvider(provider) && workspace.checkouts) {
      // A folder of checkouts: the agent reads each one's changes.
      const agentReach = await reachWorkspaceAgent(workspace.id, owner.id, {
        label: "Changes",
        needsComputer: "Viewing changes requires a Runtime Computer provider.",
      });
      if (!agentReach.ok) return agentReach.response;
      const { agent, identity } = agentReach.reached;
      const answer = await agent.workspaceChanges(identity, path ?? undefined);
      return NextResponse.json(path !== null ? { diff: answer.diff ?? "" } : { files: answer.files ?? [] });
    }
    if (isComputerProvider(provider)) {
      const reach = reachableWorktree(await getWorkspaceComputer(workspace), workspace.worktreePath);
      if (!reach.ok) return NextResponse.json({ error: reach.error }, { status: 409 });
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
