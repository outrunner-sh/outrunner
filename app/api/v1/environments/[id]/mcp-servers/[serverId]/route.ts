import { projectApiRoute } from "@/lib/api/environment-org.deps";
import { deleteMcpServerApi, updateMcpServerApi } from "@/lib/api/environment-mcp";

type RouteContext = { params: Promise<{ id: string; serverId: string }> };

/** Change one of a project's MCP servers. (docs/api.md) */
export async function PATCH(request: Request, context: RouteContext) {
  const { id, serverId } = await context.params;
  return projectApiRoute(request, id, (api) => updateMcpServerApi(api, id, serverId));
}

/** Remove one of a project's MCP servers. (docs/api.md) */
export async function DELETE(request: Request, context: RouteContext) {
  const { id, serverId } = await context.params;
  return projectApiRoute(request, id, (api) => deleteMcpServerApi(api, id, serverId));
}
