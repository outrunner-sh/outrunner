import { listScopedSecretsApi } from "@/lib/api/cursor-environments.deps";
import { apiRoute } from "@/lib/api/handler";

/** The org's secrets, which every member's sessions get: by name, never a value. */
export function GET(request: Request) {
  return apiRoute(request, (api) => listScopedSecretsApi(api, "team"));
}
