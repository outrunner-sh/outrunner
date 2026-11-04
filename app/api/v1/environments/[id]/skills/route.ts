import { enableSkillApi, listSkillsApi } from "@/lib/api/environment-skills";
import { projectApiRoute } from "@/lib/api/environment-org.deps";

type RouteContext = { params: Promise<{ id: string }> };

/** The skills.sh catalog skills enabled on a project. (docs/api.md) */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return projectApiRoute(request, id, (api) => listSkillsApi(api, id));
}

/** Enable a catalog skill on a project. (docs/api.md) */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return projectApiRoute(request, id, (api) => enableSkillApi(api, id));
}
