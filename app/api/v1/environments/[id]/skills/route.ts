import { enableSkillApi, listSkillsApi } from "@/lib/api/environment-skills";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string }> };

/** The skills.sh catalog skills enabled on a project. (docs/api.md) */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => listSkillsApi(api, id));
}

/** Enable a catalog skill on a project. (docs/api.md) */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => enableSkillApi(api, id));
}
