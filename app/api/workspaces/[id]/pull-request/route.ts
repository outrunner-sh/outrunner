import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import {
  createWorkspacePullRequest,
  getProject,
  getWorkspace,
  getWorkspacePullRequest,
  relinkWorkspacePullRequest,
} from "@/lib/db/repositories";
import { findPullRequest, getPullRequestStatus } from "@/lib/github/client";
import { githubErrorResponse } from "@/lib/github/http";
import { gitCredentialFor, withGitToken } from "@/lib/github/identity.deps";
import type { GitCredential } from "@/lib/github/identity";
import { supersedingPullRequest } from "@/lib/session/pull-request-status";
import { sessionRepo } from "@/lib/session/session-repos";
import type { WorkspacePullRequest } from "@/lib/runtime/types";
import { notePullRequestState } from "@/lib/session/pull-request-state";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The session's pull request and where it stands. The one on record, else the
 * one its agent opened for the branch on GitHub (Create PR asks it to),
 * recorded once found; `{ pullRequest: null }` while there is none yet. One on
 * record that closed unmerged gives way to a newer one from the branch. The
 * status (state, mergeability, checks) is read fresh each time, and is null
 * when GitHub couldn't be asked. `?projectId=` names one of a multi-repository
 * session's repositories; none is the session's own.
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

  const repo = sessionRepo(workspace, new URL(request.url).searchParams.get("projectId"));
  if (!repo) {
    return NextResponse.json({ error: "That repository isn't one of this session's." }, { status: 404 });
  }

  const [recorded, project] = await Promise.all([
    getWorkspacePullRequest(workspace.id, repo.projectId),
    getProject(repo.projectId),
  ]);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const repoFullName = repo.fullName ?? project.fullName;
  // As the user chose to work on GitHub (lib/github/identity.ts).
  let credential: GitCredential;
  try {
    credential = await gitCredentialFor({ userId: owner.id, orgId: project.orgId, repo: repoFullName });
  } catch (error) {
    if (recorded) return NextResponse.json({ pullRequest: recorded, status: null });
    return githubErrorResponse(error, "Could not reach GitHub. Please try again.");
  }

  let token = credential.token;
  let pullRequest: WorkspacePullRequest | null = recorded;
  if (!pullRequest) {
    let found;
    try {
      // Through withGitToken: a 401 here is what the Environment pane shows,
      // so it's said as "reconnect" only for a token GitHub confirms dead.
      // The token that answered is the one used from here on: an App token
      // refused was dropped and minted afresh.
      ({ found, token } = await withGitToken(
        owner.id,
        { orgId: project.orgId, fullName: repoFullName },
        "pull-request",
        async (t) => ({ found: await findPullRequest({ token: t, repoFullName, headBranch: workspace.branch }), token: t }),
        undefined,
        credential,
      ));
    } catch (error) {
      console.error(`Workspace ${id} pull request lookup failed`, error);
      return githubErrorResponse(error, "Could not look up the pull request. Please try again.");
    }
    if (!found) return NextResponse.json({ pullRequest: null, status: null });

    try {
      pullRequest = await createWorkspacePullRequest({
        ownerId: owner.id,
        workspaceId: workspace.id,
        projectId: repo.projectId,
        number: found.number,
        url: found.url,
        title: found.title,
        baseBranch: found.baseBranch,
        headBranch: workspace.branch,
      });
    } catch (error) {
      // Two lookups at once: the other recorded it first.
      pullRequest = await getWorkspacePullRequest(workspace.id, repo.projectId).catch(() => null);
      if (!pullRequest) {
        console.error(`Workspace ${id} pull request could not be recorded`, error);
        return NextResponse.json({ error: "Could not save the pull request. Please try again." }, { status: 500 });
      }
    }
  }

  const readStatus = (number: number) =>
    getPullRequestStatus({ token, repoFullName, number }).catch((error: unknown) => {
      console.error(`Workspace ${id} pull request status failed`, error);
      return null;
    });
  let status = await readStatus(pullRequest.number);
  // Closed unmerged: the agent may have opened another from the branch since.
  if (status?.state === "closed") {
    const newest = await findPullRequest({ token, repoFullName, headBranch: workspace.branch }).catch(() => null);
    const next = supersedingPullRequest(pullRequest, status, newest);
    if (next) {
      const relinked = await relinkWorkspacePullRequest(pullRequest.id, next).catch((error: unknown) => {
        console.error(`Workspace ${id} pull request could not be relinked`, error);
        return null;
      });
      if (relinked) {
        pullRequest = relinked;
        status = await readStatus(relinked.number);
      }
    }
  }
  // What GitHub says now, for the sidebar's groups (lib/session/standing.ts).
  if (status) await notePullRequestState(pullRequest, status.state);
  return NextResponse.json({ pullRequest, status });
}
