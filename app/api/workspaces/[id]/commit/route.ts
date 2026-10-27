import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  getWorkspaceComputer,
  getWorkspace,
} from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import {
  buildCommitMessage,
  commitMessageError,
  runCommit,
  type CommitIO,
} from "@/lib/runtime/commit";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";
import { reachableWorktree } from "@/lib/runtime/worktree-access";

const MAX_DESCRIPTION = 8_000;
type RouteContext = { params: Promise<{ id: string }> };

/**
 * Commit the worktree's uncommitted changes on its own branch — no push, no PR
 * (publish owns commit+push+PR). Reuses the same commit primitive as publish
 * via {@link runCommit}, whose IO cannot push by construction.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }
  if (workspace.status !== "ready" && workspace.status !== "idle") {
    return NextResponse.json(
      { error: "The workspace must be ready before it can be committed." },
      { status: 409 },
    );
  }
  // A folder of checkouts is no one repository: its agent commits in each
  // (Create PR, a repository at a time).
  if (workspace.checkouts) {
    return NextResponse.json(
      { error: "A session of several repositories commits in each one: use Create PR on the repository's row." },
      { status: 409 },
    );
  }

  let body: { summary?: unknown; description?: unknown };
  try {
    body = (await request.json()) as { summary?: unknown; description?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const summary = typeof body.summary === "string" ? body.summary : "";
  const description =
    typeof body.description === "string" ? body.description.slice(0, MAX_DESCRIPTION) : "";

  const invalid = commitMessageError(summary);
  if (invalid) {
    return NextResponse.json({ error: invalid }, { status: 400 });
  }

  const resolution = resolveProvider(workspace);
  if (!resolution.ok) return providerErrorResponse(resolution);
  const provider = resolution.provider;
  const author = {
    name: owner.githubLogin,
    email: owner.email ?? `${owner.githubLogin}@users.noreply.github.com`,
  };

  // Build the commit-only IO from the provider (daytona: box + worktree path;
  // otherwise: the workspace sandbox). Neither branch exposes a push. Changes
  // are listed without a base branch: only uncommitted ones are left to commit.
  let io: CommitIO;
  if (isComputerProvider(provider)) {
    const reach = reachableWorktree(await getWorkspaceComputer(workspace), workspace.worktreePath);
    if (!reach.ok) return NextResponse.json({ error: reach.error }, { status: 409 });
    const { sandboxId, worktree } = reach;
    io = {
      listChanged: () => provider.listWorkspaceChangedFiles(sandboxId, worktree),
      commit: (message) =>
        provider.commitWorkspaceChanges(sandboxId, worktree, { message, author }),
    };
  } else {
    if (!workspace.sandboxId) {
      return NextResponse.json(
        { error: "The workspace must be ready before it can be committed." },
        { status: 409 },
      );
    }
    const sandboxId = workspace.sandboxId;
    io = {
      listChanged: () => provider.listChangedFiles({ workspaceId: workspace.id, sandboxId }),
      commit: (message) =>
        provider.commitWorkspace({ workspaceId: workspace.id, sandboxId, message, author }),
    };
  }

  try {
    const message = buildCommitMessage(summary, description);
    const outcome = await runCommit(io, message);
    if (!outcome.committed) {
      return NextResponse.json({ committed: false, error: "No changes to commit." }, { status: 409 });
    }
    return NextResponse.json({ committed: true, sha: outcome.sha }, { status: 201 });
  } catch (error) {
    console.error(`Workspace ${id} commit failed`, error);
    return NextResponse.json(
      { error: "Could not commit this workspace. Check Outrunner's setup and try again." },
      { status: 502 },
    );
  }
}
