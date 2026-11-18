import { optionalEnv } from "@/lib/env";

/**
 * Reject cross-site writes. A mutating request must carry an `Origin` header
 * whose origin matches the configured `RUNTIME_BASE_URL`. Runtime is a
 * single-user, same-origin app, so this is the entire CSRF defense.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  const baseUrl = optionalEnv("RUNTIME_BASE_URL");
  if (!baseUrl) return false;
  try {
    return new URL(origin).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Reject cross-site reads that cost something to answer (a GET that asks
 * GitHub, say). Browsers send no `Origin` on a same-origin GET, so its
 * absence is no refusal here: a request that says it comes from elsewhere
 * (`Origin` another site's, or `Sec-Fetch-Site` other than same-origin) is.
 */
export function isSameOriginRead(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  return request.headers.get("origin") === null || isSameOriginRequest(request);
}
