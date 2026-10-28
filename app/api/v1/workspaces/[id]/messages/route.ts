import { apiRoute } from "@/lib/api/handler";
import { sendMessageApi } from "@/lib/api/workspaces";

type RouteContext = { params: Promise<{ id: string }> };

// Waking a paused or archived session first can take most of a minute.
export const maxDuration = 60;

/** Send the session a message (docs/api.md). */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => sendMessageApi(api, id));
}
