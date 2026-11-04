import { projectApiRoute } from "@/lib/api/environment-org.deps";
import { createMcpServerApi, listMcpServersApi } from "@/lib/api/environment-mcp";

type RouteContext = { params: Promise<{ id: string }> };

/** A project's MCP servers. (docs/api.md) */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return projectApiRoute(request, id, (api) => listMcpServersApi(api, id));
}

/** Add an MCP server to a project. (docs/api.md) */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return projectApiRoute(request, id, (api) => createMcpServerApi(api, id));
}
