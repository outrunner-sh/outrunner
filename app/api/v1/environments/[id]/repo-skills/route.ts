import { listRepoSkillsApi } from "@/lib/api/environment-skills";
import { projectOutsideOrg } from "@/lib/api/environment-org.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

// As the project page's route: each repository is read from GitHub.
export const maxDuration = 60;

/** The skills, subagents and commands a project's repositories commit.
 *  (docs/api.md) */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, async (api) => (await projectOutsideOrg(api, id)) ?? listRepoSkillsApi(api, id));
}
