import { apiRoute } from "@/lib/api/handler";
import { deleteAutomationApi, getAutomationApi, updateAutomationApi } from "@/lib/api/org";

type RouteContext = { params: Promise<{ id: string }> };

/** One automation. (docs/api.md) */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => getAutomationApi(api, id));
}

/** Change an automation: the org's admins may. (docs/api.md) */
export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => updateAutomationApi(api, id));
}

/** Delete an automation: the org's admins may. (docs/api.md) */
export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  return apiRoute(request, (api) => deleteAutomationApi(api, id));
}
