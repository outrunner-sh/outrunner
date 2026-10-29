import { apiRoute } from "@/lib/api/handler";
import { deletePreviewApi, updatePreviewApi } from "@/lib/api/previews";

type RouteContext = { params: Promise<{ id: string; previewId: string }> };

/** Rename a preview or switch its mode (docs/api.md#previews). */
export async function PATCH(request: Request, context: RouteContext) {
  const { id, previewId } = await context.params;
  return apiRoute(request, (api) => updatePreviewApi(api, id, previewId));
}

/** Delete a preview: its link stops working for everyone. */
export async function DELETE(request: Request, context: RouteContext) {
  const { id, previewId } = await context.params;
  return apiRoute(request, (api) => deletePreviewApi(api, id, previewId));
}
