import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  createWorkspacePullRequest,
  getProject,
  getRuntimeComputerByProject,
  getWorkspace,
  getWorkspacePullRequest,
} from "@/lib/db/repositories";
import {
  findOrCreatePullRequest,
  verifyTokenOwner,
} from "@/lib/github/client";
import { githubErrorResponse } from "@/lib/github/response";
import { optionalGithubToken } from "@/lib/github/token";
import { isSameOriginRequest } from "@/lib/http/guards";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";

export const dynamic = "force-dynamic";

const MAX_TITLE = 256;
const MAX_BODY = 8_000;
type RouteContext = { params: Promise<{ id: string }> };

/** Commit the worktree as the owner, push its branch, and open one PR. */
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
      { error: "The workspace must be ready before it can be published." },
      { status: 409 },
    );
  }
  const project = await getProject(workspace.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  let body: { title?: unknown; body?: unknown };
  try {
    body = (await request.json()) as { title?: unknown; body?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const title =
    (typeof body.title === "string" && body.title.trim().slice(0, MAX_TITLE)) ||
    // The session's own name (its first prompt), else its branch.
    (workspace.title ?? workspace.branch);
  const prBody = typeof body.body === "string" ? body.body.slice(0, MAX_BODY) : "";

  const githubToken = await optionalGithubToken(owner.id);
  if (!githubToken) {
    return NextResponse.json(
      {
        error:
          "Connect your GitHub account to publish: sign out and back in to grant repository access.",
        reconnect: true,
      },
      { status: 409 },
    );
  }

  const resolution = resolveProvider(workspace);
  if (!resolution.ok) return providerErrorResponse(resolution);
  const provider = resolution.provider;
  const onComputer = isComputerProvider(provider);
  if (!onComputer && !workspace.sandboxId) {
    return NextResponse.json(
      { error: "The workspace must be ready before it can be published." },
      { status: 409 },
    );
  }

  // Idempotent: a persisted PR record means this workspace is already published.
  const existing = await getWorkspacePullRequest(workspace.id);
  if (existing) {
    return NextResponse.json({ pullRequest: existing, alreadyPublished: true });
  }

  // Confirm the stored token still belongs to the signed-in user before use:
  // a provider_token can be revoked on GitHub's side at any time.
  try {
    await verifyTokenOwner(githubToken, owner.githubLogin);
  } catch (error) {
    console.error(`Workspace ${id} publish token check failed`, error);
    return (
      githubErrorResponse(error) ??
      NextResponse.json(
        { error: "Could not verify your GitHub connection. Please try again." },
        { status: 502 },
      )
    );
  }

  try {
    if (onComputer) {
      const computer = await getRuntimeComputerByProject(workspace.projectId);
      if (!computer?.daytonaSandboxId || !workspace.worktreePath) {
        return NextResponse.json(
          { error: "The interactive worktree is not available yet." },
          { status: 409 },
        );
      }
      const changed = await provider.listWorkspaceChangedFiles(
        computer.daytonaSandboxId,
        workspace.worktreePath,
      );
      if (changed.length > 0) {
        await provider.commitWorkspaceChanges(
          computer.daytonaSandboxId,
          workspace.worktreePath,
          {
            message: title,
            author: {
              name: owner.githubLogin,
              email: owner.email ?? `${owner.githubLogin}@users.noreply.github.com`,
            },
          },
        );
      }
      await provider.pushWorkspaceChanges(
        computer.daytonaSandboxId,
        workspace.worktreePath,
        {
          repoFullName: project.fullName,
          branch: workspace.branch,
          githubToken,
        },
      );
    } else {
      const changed = await provider.listChangedFiles({
        workspaceId: workspace.id,
        sandboxId: workspace.sandboxId!,
      });
      if (changed.length > 0) {
        await provider.commitWorkspace({
          workspaceId: workspace.id,
          sandboxId: workspace.sandboxId!,
          message: title,
          author: {
            name: owner.githubLogin,
            email: owner.email ?? `${owner.githubLogin}@users.noreply.github.com`,
          },
        });
      }
      await provider.pushWorkspaceBranch({
        workspaceId: workspace.id,
        sandboxId: workspace.sandboxId!,
        repoFullName: project.fullName,
        branch: workspace.branch,
        githubToken,
      });
    }
  } catch (error) {
    console.error(`Workspace ${id} commit/push failed`, error);
    return NextResponse.json(
      { error: "Could not commit and push this workspace. Check Outrunner's setup and try again." },
      { status: 502 },
    );
  }

  let pr;
  try {
    pr = await findOrCreatePullRequest({
      token: githubToken,
      repoFullName: project.fullName,
      headBranch: workspace.branch,
      baseBranch: workspace.baseBranch,
      title,
      body: prBody,
    });
  } catch (error) {
    console.error(`Workspace ${id} pull request failed`, error);
    return (
      githubErrorResponse(error) ??
      NextResponse.json(
        { error: "Could not open a pull request. Please try again." },
        { status: 502 },
      )
    );
  }

  try {
    const record = await createWorkspacePullRequest({
      ownerId: owner.id,
      workspaceId: workspace.id,
      number: pr.number,
      url: pr.url,
      title,
      baseBranch: workspace.baseBranch,
      headBranch: workspace.branch,
    });
    return NextResponse.json({ pullRequest: record }, { status: 201 });
  } catch (error) {
    // A concurrent publish may have persisted the record first; prefer it.
    const persisted = await getWorkspacePullRequest(workspace.id).catch(() => null);
    if (persisted) {
      return NextResponse.json({ pullRequest: persisted });
    }
    console.error(`Workspace ${id} pull request record could not be saved`, error);
    return NextResponse.json(
      { error: "Pull request opened, but Outrunner could not save it. Refresh before publishing again." },
      { status: 500 },
    );
  }
}
