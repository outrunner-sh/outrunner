import { listAllSecretsApi } from "@/lib/api/cursor-environments.deps";
import { apiRoute } from "@/lib/api/handler";

/** The org's secrets, the caller's own, and a project's, by name, never a
 *  value: `scope`, `environmentId`, `name`, `repo`. */
export function GET(request: Request) {
  return apiRoute(request, listAllSecretsApi);
}
