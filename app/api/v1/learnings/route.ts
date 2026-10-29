import { apiRoute } from "@/lib/api/handler";
import { createLearningApi, listLearningsApi } from "@/lib/api/learnings";

/** The org's learnings and the key's maker's own (docs/api.md). */
export function GET(request: Request) {
  return apiRoute(request, listLearningsApi);
}

/** Add a learning, or suggest one for the org. */
export function POST(request: Request) {
  return apiRoute(request, createLearningApi);
}
