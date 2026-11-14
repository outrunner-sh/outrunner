import { getOwner } from "@/lib/auth/owner";
import { requireGitLabToken } from "@/lib/db/gitlab-connections";
import { listProjects, upsertGitLabProjects } from "@/lib/db/repositories";
import { getGitLabRepository, gitLabErrorResponse } from "@/lib/gitlab/client";
import { readCappedBody } from "@/lib/http/capped-body";
import { isSameOriginRequest } from "@/lib/http/guards";
import { connectRefusal } from "@/lib/orgs/connect-access";
import { activeOrgId } from "@/lib/orgs/server";

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return Response.json({ error: "Sign in first." }, { status: 401 });
  let id: unknown;
  const raw = await readCappedBody(request, 4096);
  try { id = raw === null ? null : JSON.parse(raw).repoId; } catch { /* invalid JSON */ }
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return Response.json({ error: "Choose a GitLab repository." }, { status: 400 });
  try {
    const orgId = await activeOrgId();
    const refused = await connectRefusal(owner.id, orgId);
    if (refused) return refused;
    const token = await requireGitLabToken(owner.id);
    const repo = await getGitLabRepository(token, id);
    if (!repo) return Response.json({ error: "Your GitLab account cannot access this repository." }, { status: 403 });
    await upsertGitLabProjects(owner.id, [repo], orgId);
    return Response.json({ projects: await listProjects(orgId) });
  } catch (error) { return gitLabErrorResponse(error); }
}
