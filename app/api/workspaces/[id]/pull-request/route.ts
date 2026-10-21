import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  createWorkspacePullRequest,
  getProject,
  getWorkspace,
  getWorkspacePullRequest,
} from "@/lib/db/repositories";
import { findPullRequest, getPullRequestStatus, MissingGithubTokenError } from "@/lib/github/client";
import { githubErrorResponse } from "@/lib/github/http";
import { optionalGithubToken } from "@/lib/github/token";
import type { WorkspacePullRequest } from "@/lib/runtime/types";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The session's pull request and where it stands. The one on record, else the
 * one its agent opened for the branch on GitHub (Create PR asks it to),
 * recorded once found; `{ pullRequest: null }` while there is none yet. The
 * status (state, mergeability, checks) is read fresh each time, and is null
 * when GitHub couldn't be asked.
 */
export async function GET(_request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  const recorded = await getWorkspacePullRequest(workspace.id);
  const token = await optionalGithubToken(owner.id);
  if (!token) {
    if (recorded) return NextResponse.json({ pullRequest: recorded, status: null });
    return githubErrorResponse(new MissingGithubTokenError(), "Connect your GitHub account.");
  }
  const project = await getProject(workspace.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  let pullRequest: WorkspacePullRequest | null = recorded;
  if (!pullRequest) {
    let found;
    try {
      found = await findPullRequest({ token, repoFullName: project.fullName, headBranch: workspace.branch });
    } catch (error) {
      console.error(`Workspace ${id} pull request lookup failed`, error);
      return githubErrorResponse(error, "Could not look up the pull request. Please try again.");
    }
    if (!found) return NextResponse.json({ pullRequest: null, status: null });

    try {
      pullRequest = await createWorkspacePullRequest({
        ownerId: owner.id,
        workspaceId: workspace.id,
        number: found.number,
        url: found.url,
        title: found.title,
        baseBranch: found.baseBranch,
        headBranch: workspace.branch,
      });
    } catch (error) {
      // Two lookups at once: the other recorded it first.
      pullRequest = await getWorkspacePullRequest(workspace.id).catch(() => null);
      if (!pullRequest) {
        console.error(`Workspace ${id} pull request could not be recorded`, error);
        return NextResponse.json({ error: "Could not save the pull request. Please try again." }, { status: 500 });
      }
    }
  }

  const status = await getPullRequestStatus({
    token,
    repoFullName: project.fullName,
    number: pullRequest.number,
  }).catch((error: unknown) => {
    console.error(`Workspace ${id} pull request status failed`, error);
    return null;
  });
  return NextResponse.json({ pullRequest, status });
}
