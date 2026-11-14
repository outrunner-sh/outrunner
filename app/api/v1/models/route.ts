import { apiRoute } from "@/lib/api/handler";
import { listModelsApi } from "@/lib/api/models.deps";

/** The models the key's maker can start a session on (docs/api.md). */
export function GET(request: Request) {
  return apiRoute(request, listModelsApi);
}
