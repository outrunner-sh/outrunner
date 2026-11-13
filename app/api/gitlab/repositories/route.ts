import { getOwner } from "@/lib/auth/owner";
import { requireGitLabToken } from "@/lib/db/gitlab-connections";
import { listProjects } from "@/lib/db/repositories";
import { gitLabErrorResponse, listGitLabRepositories } from "@/lib/gitlab/client";
import { toListing } from "@/lib/github/listing";
import { activeOrgId } from "@/lib/orgs/server";

export async function GET() {
  const owner = await getOwner();
  if (!owner) return Response.json({ error: "Sign in to browse repositories." }, { status: 401 });
  try {
    const token = await requireGitLabToken(owner.id);
    const orgId = await activeOrgId();
    const [list, projects] = await Promise.all([listGitLabRepositories(token), listProjects(orgId)]);
    return Response.json({
      repositories: list.repositories.map(toListing), complete: list.complete,
      connected: projects.filter((p) => p.provider === "gitlab").map((p) => p.repositoryId),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return gitLabErrorResponse(error); }
}
