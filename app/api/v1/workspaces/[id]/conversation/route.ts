import { apiRoute } from "@/lib/api/handler";
import { readConversationApi } from "@/lib/api/workspaces";

type RouteContext = { params: Promise<{ id: string }> };

/** The session's conversation, a page at a time going back (docs/api.md). */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => readConversationApi(api, id));
}
