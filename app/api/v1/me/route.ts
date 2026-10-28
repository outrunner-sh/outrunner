import { meApi } from "@/lib/api/catalog";
import { apiRoute } from "@/lib/api/handler";

/** Who the key acts as, in which org, with what role (docs/api.md). */
export function GET(request: Request) {
  return apiRoute(request, meApi);
}
