import { isGitLabRef } from "@/lib/code-providers/repository";
import { NextResponse } from "next/server";

import { getEnvironment } from "@/lib/db/environments";
import { optionalGitToken } from "@/lib/github/identity.deps";
import { committedSkills } from "@/lib/github/skills";
import { environmentRequest, projectNotFound } from "@/lib/http/environment-request";

type RouteContext = { params: Promise<{ id: string }> };

// Each repository's tree is read from GitHub, a few calls apiece.
export const maxDuration = 60;

/**
 * The skills, subagents and commands a project's repositories commit for
 * Claude Code (.claude/skills, agents, commands) and Codex (.agents/skills),
 * on the branch its sessions start from. Read-only: a session gets them with
 * its checkout, so nothing installs them. Read with the token a session's
 * clone would use (lib/github/identity.ts); a repository GitHub won't list
 * is named in `errors`.
 */
export async function GET(request: Request, context: RouteContext) {
  const c = await environmentRequest(request, context.params);
  if ("response" in c) return c.response;
  const environment = await getEnvironment(c.owner.id, c.params.id);
  if (!environment) return projectNotFound();
  const errors: string[] = [];
  const perRepo = await Promise.all(
    environment.repos.map(async (repo) => {
      if (isGitLabRef(repo.fullName)) {
        errors.push(`Skills from ${repo.fullName} are available in the session checkout; browsing GitLab skills is not supported yet.`);
        return [];
      }
      const branch = repo.branch ?? repo.defaultBranch;
      const token = await optionalGitToken(c.owner.id, { orgId: environment.orgId, fullName: repo.fullName });
      const items = await committedSkills(token, repo.fullName, branch);
      if (!items) {
        errors.push(`GitHub wouldn't list ${repo.fullName}'s files.`);
        return [];
      }
      return items.map((item) => ({ ...item, projectId: repo.projectId, fullName: repo.fullName, branch }));
    }),
  );
  return NextResponse.json({ items: perRepo.flat(), errors });
}
