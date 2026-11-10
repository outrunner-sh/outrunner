import { apiRoute } from "@/lib/api/handler";
import { usageApi } from "@/lib/api/org";

/** The org's cloud hours and their controls. (docs/api.md) */
export async function GET(request: Request) {
  return apiRoute(request, usageApi);
}
