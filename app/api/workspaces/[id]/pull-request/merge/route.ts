import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { projectLevel } from "@/lib/db/org-access";
import { getProject, getWorkspace, getWorkspacePullRequest } from "@/lib/db/repositories";
import { getPullRequestStatus, mergePullRequest } from "@/lib/github/client";
import { githubErrorResponse } from "@/lib/github/http";
import { requireGitToken } from "@/lib/github/identity.deps";
import { allows } from "@/lib/orgs/access";
import { isSameOriginRequest } from "@/lib/http/guards";
import { sessionRepo } from "@/lib/session/session-repos";
import { notePullRequestState } from "@/lib/session/pull-request-state";

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
  const project = await getProject(repo.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const repoFullName = repo.fullName ?? project.fullName;
  // Merging as the org's App, GitHub can't tell who asked: Outrunner's own
  // access says whether they may.
  if (!allows(await projectLevel(owner.id, project.id), "write")) {
    return NextResponse.json({ error: `You can only read ${repoFullName} in this org.` }, { status: 403 });
  }

  let token: string;
  try {
    token = await requireGitToken(owner.id, { orgId: project.orgId, fullName: repoFullName });
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
  // Done, for the sidebar at once, before the webhook says so.
  await notePullRequestState(pullRequest, "merged");
  return NextResponse.json({ merged: true, status });
}
