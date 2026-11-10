import { apiRoute } from "@/lib/api/handler";
import { listMembersApi } from "@/lib/api/org";

/** The org's members and their roles. (docs/api.md) */
export async function GET(request: Request) {
  return apiRoute(request, listMembersApi);
}
