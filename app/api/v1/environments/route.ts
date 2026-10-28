import { listEnvironmentsApi } from "@/lib/api/catalog";
import { apiRoute } from "@/lib/api/handler";

/** The org's projects (environments) the key's maker may read (docs/api.md). */
export function GET(request: Request) {
  return apiRoute(request, listEnvironmentsApi);
}
