import { disableSkillApi } from "@/lib/api/environment-skills";
import { projectOutsideOrg } from "@/lib/api/environment-org.deps";
import { apiRoute } from "@/lib/api/handler";

type RouteContext = { params: Promise<{ id: string; skillId: string }> };

/** Disable a catalog skill on a project. (docs/api.md) */
export async function DELETE(request: Request, context: RouteContext) {
  const { id, skillId } = await context.params;
  return apiRoute(request, async (api) => (await projectOutsideOrg(api, id)) ?? disableSkillApi(api, id, skillId));
}
