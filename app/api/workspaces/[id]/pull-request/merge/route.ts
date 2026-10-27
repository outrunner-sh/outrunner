import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getProject, getWorkspace, getWorkspacePullRequest } from "@/lib/db/repositories";
import { getPullRequestStatus, mergePullRequest } from "@/lib/github/client";
import { githubErrorResponse } from "@/lib/github/http";
import { requireGithubToken } from "@/lib/github/token";
import { isSameOriginRequest } from "@/lib/http/guards";
import { sessionRepo } from "@/lib/session/session-repos";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Merge the session's pull request as the user, at `headSha`: the commit
 * whose green status they clicked Merge on; `projectId` names one of a
 * multi-repository session's repositories (none: its own). Answers with the
 * status after.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { headSha?: unknown; projectId?: unknown } | null;
  const headSha = typeof body?.headSha === "string" && /^[0-9a-f]{40}$/.test(body.headSha) ? body.headSha : null;
  if (!headSha) {
    return NextResponse.json({ error: "Say which commit to merge." }, { status: 400 });
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }
  const repo = sessionRepo(workspace, typeof body?.projectId === "string" ? body.projectId : null);
  if (!repo) {
    return NextResponse.json({ error: "That repository isn't one of this session's." }, { status: 404 });
  }
  const pullRequest = await getWorkspacePullRequest(workspace.id, repo.projectId);
  if (!pullRequest) {
    return NextResponse.json({ error: "This session has no pull request there." }, { status: 404 });
  }
  const repoFullName = repo.fullName ?? (await getProject(workspace.projectId))?.fullName;
  if (!repoFullName) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  let token: string;
  try {
    token = await requireGithubToken(owner.id);
    await mergePullRequest({ token, repoFullName, number: pullRequest.number, headSha });
  } catch (error) {
    console.error(`Workspace ${id} pull request merge failed`, error);
    return githubErrorResponse(error, "Could not merge the pull request. Please try again.");
  }

  const status = await getPullRequestStatus({
    token,
    repoFullName,
    number: pullRequest.number,
  }).catch(() => null);
  return NextResponse.json({ merged: true, status });
}
