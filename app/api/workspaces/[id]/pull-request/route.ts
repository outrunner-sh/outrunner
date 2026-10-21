import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  createWorkspacePullRequest,
  getProject,
  getWorkspace,
  getWorkspacePullRequest,
} from "@/lib/db/repositories";
import { findPullRequest } from "@/lib/github/client";
import { githubErrorResponse } from "@/lib/github/http";
import { requireGithubToken } from "@/lib/github/token";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The session's pull request: the one on record, else the one its agent opened
 * for the branch on GitHub (Create PR asks it to), recorded once found.
 * `{ pullRequest: null }` while there is none yet.
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
  if (recorded) return NextResponse.json({ pullRequest: recorded });

  const project = await getProject(workspace.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  let found;
  try {
    found = await findPullRequest({
      token: await requireGithubToken(owner.id),
      repoFullName: project.fullName,
      headBranch: workspace.branch,
    });
  } catch (error) {
    console.error(`Workspace ${id} pull request lookup failed`, error);
    return githubErrorResponse(error, "Could not look up the pull request. Please try again.");
  }
  if (!found) return NextResponse.json({ pullRequest: null });

  try {
    const pullRequest = await createWorkspacePullRequest({
      ownerId: owner.id,
      workspaceId: workspace.id,
      number: found.number,
      url: found.url,
      title: found.title,
      baseBranch: found.baseBranch,
      headBranch: workspace.branch,
    });
    return NextResponse.json({ pullRequest });
  } catch (error) {
    // Two lookups at once: the other recorded it first.
    const persisted = await getWorkspacePullRequest(workspace.id).catch(() => null);
    if (persisted) return NextResponse.json({ pullRequest: persisted });
    console.error(`Workspace ${id} pull request could not be recorded`, error);
    return NextResponse.json({ error: "Could not save the pull request. Please try again." }, { status: 500 });
  }
}
