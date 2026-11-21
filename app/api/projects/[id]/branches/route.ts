import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { listBranches } from "@/lib/code-providers/client";
import { getProject } from "@/lib/db/repositories";
import { githubErrorResponse } from "@/lib/github/http";
import { optionalGitToken } from "@/lib/github/identity.deps";
import { baseBranchChoices, BRANCHES_SHOWN, MAX_BRANCH_QUERY } from "@/lib/session/base-branch";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The repository's branches a new session may start from, for the
 * new-session screen's branch picker: those whose name holds `q`, the
 * default branch first. Asked of GitHub (or GitLab) with the user's token;
 * with none, only the default branch, which a session can always start from.
 */
export async function GET(request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const { id } = await context.params;
  // Row-level security: only a repository the user can see.
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const query = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, MAX_BRANCH_QUERY);
  const token = await optionalGitToken(owner.id, { orgId: project.orgId, fullName: project.fullName });
  if (!token) {
    return NextResponse.json(baseBranchChoices({ branches: [], total: 0 }, project.defaultBranch, query));
  }
  try {
    const found = await listBranches({ token, repoFullName: project.fullName, query, first: BRANCHES_SHOWN });
    return NextResponse.json(baseBranchChoices(found, project.defaultBranch, query));
  } catch (error) {
    return githubErrorResponse(error, "Could not list the repository's branches. Please try again.");
  }
}
