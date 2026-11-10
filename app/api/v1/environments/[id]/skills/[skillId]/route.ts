import { disableSkillApi } from "@/lib/api/environment-skills";
import { projectApiRoute } from "@/lib/api/environment-org.deps";

type RouteContext = { params: Promise<{ id: string; skillId: string }> };

/** Disable a catalog skill on a project. (docs/api.md) */
export async function DELETE(request: Request, context: RouteContext) {
  const { id, skillId } = await context.params;
  return projectApiRoute(request, id, (api) => disableSkillApi(api, id, skillId));
}
