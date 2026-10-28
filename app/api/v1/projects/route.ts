import { listProjectsApi } from "@/lib/api/catalog";
import { apiRoute } from "@/lib/api/handler";

/** The org's repositories the key's maker may start sessions on (docs/api.md). */
export function GET(request: Request) {
  return apiRoute(request, listProjectsApi);
}
