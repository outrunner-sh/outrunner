import { enableSkillApi, listSkillsApi } from "@/lib/api/environment-skills";
import { projectOutsideOrg } from "@/lib/api/environment-org.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

/** The skills.sh catalog skills enabled on a project. (docs/api.md) */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, async (api) => (await projectOutsideOrg(api, id)) ?? listSkillsApi(api, id));
}

/** Enable a catalog skill on a project. (docs/api.md) */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, async (api) => (await projectOutsideOrg(api, id)) ?? enableSkillApi(api, id));
}
