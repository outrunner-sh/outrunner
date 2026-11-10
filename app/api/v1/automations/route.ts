import { apiRoute } from "@/lib/api/handler";
import { createAutomationApi, listAutomationsApi } from "@/lib/api/org";

/** The org's automations. (docs/api.md) */
export async function GET(request: Request) {
  return apiRoute(request, listAutomationsApi);
}

/** Make an automation: the org's admins may. (docs/api.md) */
export async function POST(request: Request) {
  return apiRoute(request, createAutomationApi);
}
