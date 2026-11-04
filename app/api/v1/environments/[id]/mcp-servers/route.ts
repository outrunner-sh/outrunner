import { projectOutsideOrg } from "@/lib/api/environment-org.deps";
import { apiRoute } from "@/lib/api/handler";
import { createMcpServerApi, listMcpServersApi } from "@/lib/api/environment-mcp";

type RouteContext = { params: Promise<{ id: string }> };

/** A project's MCP servers. (docs/api.md) */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, async (api) => (await projectOutsideOrg(api, id)) ?? listMcpServersApi(api, id));
}

/** Add an MCP server to a project. (docs/api.md) */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, async (api) => (await projectOutsideOrg(api, id)) ?? createMcpServerApi(api, id));
}
