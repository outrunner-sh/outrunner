import { apiRoute } from "@/lib/api/handler";
import { listChatsApi } from "@/lib/api/workspaces";

type RouteContext = { params: Promise<{ id: string }> };

/** The session's chats, its main one first (docs/api.md). */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => listChatsApi(api, id));
}
