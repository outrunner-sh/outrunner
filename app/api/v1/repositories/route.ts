import { listRepositoriesApi } from "@/lib/api/catalog";
import { apiRoute } from "@/lib/api/handler";

/** The org's repositories the key's maker may start agents on, as Cursor's
 *  API lists them (`items` of `url`); GET /projects says more of each. */
export function GET(request: Request) {
  return apiRoute(request, listRepositoriesApi);
}
