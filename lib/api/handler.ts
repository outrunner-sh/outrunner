/**
 * Every public API route (app/api/v1, app/api/mcp) runs through here: the
 * call is signed in with its key (lib/api/auth.ts), held to its rate limit,
 * run as the key's maker exactly as their browser would be (signed in as
 * them, under RLS, through the app's own routes), and recorded, with who
 * made it, in api_requests.
 *
 * A bearer key needs no Origin check: no browser sends one on its own.
 */

import { after } from "@/lib/observability/after";

import { authorize, wantedOrg, type ApiCaller } from "@/lib/api/auth";
import { apiAuthDeps } from "@/lib/api/auth.deps";
import { apiError } from "@/lib/api/errors";
import { apiCredential } from "@/lib/api/keys";
import { DEFAULT_LIMIT, RateLimiter, rateHeaders, type RateLimitRule } from "@/lib/api/rate-limit";
import { getOwner, type Owner } from "@/lib/auth/owner";
import { recordApiRequest, touchApiKey, touchCliToken } from "@/lib/db/api-keys";
import { optionalEnv } from "@/lib/env";
import { reportError } from "@/lib/observability/report";
import { ActAsUserError, actAsUserKept } from "@/lib/supabase/acting-user";

export type ApiContext = {
  caller: ApiCaller;
  owner: Owner;
  /** The app's own address, for links and for calling its routes. */
  base: string;
  request: Request;
};

const limiter = new RateLimiter();

/** Spend `count` of the caller's calls under `limit`, counted in `bucket`,
 *  all or none: for a call that does more than one thing (an MCP tool that
 *  starts a session, a batch of tool calls). */
export function takeLimit(caller: ApiCaller, limit: RateLimitRule, bucket: string, count = 1) {
  return limiter.take(`${caller.keyId ?? caller.cliTokenId}:${bucket}`, limit, count);
}

/** Keys and CLI tokens marked used at most once a minute each: last-used
 *  is a day's detail, and a polling script shouldn't make every call a write. */
const touched = new Map<string, number>();

function appBase(request: Request): string {
  return optionalEnv("RUNTIME_BASE_URL") ?? new URL(request.url).origin;
}

/**
 * Answer an API call with `work`, run as the key's maker. `limit` is the
 * call's rate rule; a rule of its own (starting a session) is counted
 * apart from the rest.
 */
export async function apiRoute(
  request: Request,
  work: (context: ApiContext) => Promise<Response>,
  { limit = DEFAULT_LIMIT, bucket = "default" }: { limit?: RateLimitRule; bucket?: string } = {},
): Promise<Response> {
  const path = new URL(request.url).pathname;
  let auth;
  try {
    auth = await authorize(apiCredential(request.headers), wantedOrg(request), apiAuthDeps);
  } catch (error) {
    console.error(`API: couldn't sign in a call to ${path}`, error);
    return apiError(503, "Outrunner couldn't check that key just now. Try again.");
  }
  if (!auth.ok) return apiError(auth.status, auth.message);
  const { caller } = auth;

  const decision = takeLimit(caller, limit, bucket);
  const limitHeaders = rateHeaders(decision);
  let response: Response;
  if (!decision.allowed) {
    response = apiError(429, `Too many calls. Try again in ${Math.max(1, decision.retryAfter)}s.`, { headers: limitHeaders });
  } else {
    response = await run(request, caller, work);
    for (const [name, value] of Object.entries(limitHeaders)) response.headers.set(name, value);
  }

  const status = response.status;
  after(async () => {
    await recordApiRequest({
      keyId: caller.keyId,
      cliTokenId: caller.cliTokenId,
      userId: caller.userId,
      orgId: caller.orgId,
      method: request.method,
      path,
      status,
    }).catch((error: unknown) => console.error("API: couldn't record a call", error));
    const credential = caller.keyId ? `key:${caller.keyId}` : `cli:${caller.cliTokenId}`;
    if (Date.now() - (touched.get(credential) ?? 0) > 60_000) {
      if (touched.size > 10_000) touched.clear();
      touched.set(credential, Date.now());
      const touch = caller.keyId ? touchApiKey(caller.keyId) : touchCliToken(caller.cliTokenId as string);
      await touch.catch((error: unknown) => console.error("API: couldn't mark a key used", error));
    }
  });
  return response;
}

async function run(request: Request, caller: ApiCaller, work: (context: ApiContext) => Promise<Response>): Promise<Response> {
  try {
    return await actAsUserKept(caller.userId, async () => {
      const owner = await getOwner();
      if (!owner) return apiError(401, "That account can't use Outrunner any more.");
      const response = await work({ caller, owner, base: appBase(request), request });
      // A response from Response.json has immutable headers in some
      // runtimes; copied, so the rate headers can be set on it.
      return new Response(response.body, { status: response.status, headers: new Headers(response.headers) });
    });
  } catch (error) {
    if (error instanceof ActAsUserError) return apiError(401, error.message);
    console.error(`API: ${request.method} ${new URL(request.url).pathname} failed`, error);
    reportError(error, { where: "api", orgId: caller.orgId, userId: caller.userId, extra: { method: request.method, path: new URL(request.url).pathname } });
    return apiError(500, "Outrunner couldn't do that. It logged why; try again.");
  }
}

/** A JSON body (none is an empty one), or the reason it isn't one. */
export async function jsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await request.text().catch(() => "");
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return apiError(400, "The body isn't JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError(400, "Send a JSON object as the body.");
  }
  return body as Record<string, unknown>;
}

/**
 * A request to one of the app's own routes, as the browser would make it
 * (same origin, JSON), for calling it inside apiRoute's work: the session's
 * own code paths, rather than copies of them.
 */
export function appRequest(base: string, path: string, { method = "POST", body }: { method?: string; body?: unknown } = {}): Request {
  return new Request(new URL(path, base), {
    method,
    headers: {
      origin: new URL(base).origin,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

/** The params a dynamic route handler is called with. */
export function routeParams<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}
