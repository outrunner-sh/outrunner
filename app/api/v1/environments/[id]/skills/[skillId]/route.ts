import { disableSkillApi } from "@/lib/api/environment-skills";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string; skillId: string }> };

/** Disable a catalog skill on a project. (docs/api.md) */
export async function DELETE(request: Request, context: RouteContext) {
  const { id, skillId } = await context.params;
  return apiRoute(request, (api) => disableSkillApi(api, id, skillId));
}
