import { projectOutsideOrg } from "@/lib/api/environment-org.deps";
import { apiRoute } from "@/lib/api/handler";
import { deleteMcpServerApi, updateMcpServerApi } from "@/lib/api/environment-mcp";

type RouteContext = { params: Promise<{ id: string; serverId: string }> };

/** Change one of a project's MCP servers. (docs/api.md) */
export async function PATCH(request: Request, context: RouteContext) {
  const { id, serverId } = await context.params;
  return apiRoute(request, async (api) => (await projectOutsideOrg(api, id)) ?? updateMcpServerApi(api, id, serverId));
}

/** Remove one of a project's MCP servers. (docs/api.md) */
export async function DELETE(request: Request, context: RouteContext) {
  const { id, serverId } = await context.params;
  return apiRoute(request, async (api) => (await projectOutsideOrg(api, id)) ?? deleteMcpServerApi(api, id, serverId));
}
