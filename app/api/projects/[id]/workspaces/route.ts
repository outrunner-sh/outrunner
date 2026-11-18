import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getEnvironment } from "@/lib/db/environments";
import { isSameOriginRequest } from "@/lib/http/guards";
import { isUuid } from "@/lib/ids";
import { createCloudSession, type SessionRequest } from "@/lib/session/create-cloud-session";

// Lazy provisioning boots a Daytona box + agent (~19s, about 4 from the warm
// pool) plus a repo mirror, in after() once the response has gone, and then
// refills the pool for the project's next session (as long again, longer for
// a large repository). maxDuration caps the per-request wall-clock, after()
// included, on serverless hosts: 60s does not cover both there. Outrunner runs
// as a long-running server (server.ts on Cloudflare Containers), where it is a
// no-op; a refill a restart cuts off is replaced by the next one
// (lib/runtime/warm-pool.ts) and its box swept by the reconciler, and a
// session's setup it cuts off is failed by the reconciler too
// (lib/session/provisioning.deps.ts), for the user to try again.
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Create one session of a repository (lib/session/create-cloud-session.ts),
 * from the environment picked on the new-session screen (`environmentId`),
 * or the repository's own. A picked one must be one the user can read that
 * holds this repository: the session works in it, the environment's others
 * beside it.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json(
      { error: "Sign in to Outrunner first." },
      { status: 401 },
    );
  }

  const { id } = await context.params;
  let body: SessionRequest;
  try {
    body = (await request.json()) as SessionRequest;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (body.environmentId === undefined || body.environmentId === null) return createCloudSession(owner, id, body);
  const environment = typeof body.environmentId === "string" && isUuid(body.environmentId)
    ? await getEnvironment(owner.id, body.environmentId)
    : null;
  if (!environment) {
    return NextResponse.json({ error: "That environment isn't there any more, or you can't see it. Pick another." }, { status: 404 });
  }
  if (!environment.repos.some((r) => r.projectId === id)) {
    return NextResponse.json({ error: "That repository isn't in this environment. Pick the environment again." }, { status: 400 });
  }
  return createCloudSession(owner, id, body, { environmentId: environment.id });
}
