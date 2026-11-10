import { openApiSpec } from "@/lib/api/openapi";
import { optionalEnv } from "@/lib/env";

/** The API's OpenAPI description: no key needed, it holds no one's data. */
export function GET(request: Request) {
  const base = optionalEnv("RUNTIME_BASE_URL") ?? new URL(request.url).origin;
  return Response.json(openApiSpec(base), { headers: { "cache-control": "public, max-age=300" } });
}
