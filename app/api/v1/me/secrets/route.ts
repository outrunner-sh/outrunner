import { listScopedSecretsApi } from "@/lib/api/cursor-environments.deps";
import { apiRoute } from "@/lib/api/handler";

/** The caller's own secrets, which their sessions get in any org: by name, never a value. */
export function GET(request: Request) {
  return apiRoute(request, (api) => listScopedSecretsApi(api, "user"));
}
