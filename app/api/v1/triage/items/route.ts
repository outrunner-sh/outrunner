import { createTriageApi, listTriageApi } from "@/lib/api/catalog";
import { apiRoute } from "@/lib/api/handler";

/** The org's work items the key's maker may see (docs/api.md). */
export function GET(request: Request) {
  return apiRoute(request, listTriageApi);
}

/** File a work item in triage. */
export function POST(request: Request) {
  return apiRoute(request, createTriageApi);
}
