import { apiRoute } from "@/lib/api/handler";
import { listAutomationRunsApi } from "@/lib/api/org";

/** The org's recent automation runs. (docs/api.md) */
export async function GET(request: Request) {
  return apiRoute(request, listAutomationRunsApi);
}
