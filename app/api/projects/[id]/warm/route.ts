import { NextResponse } from "next/server";

import { after } from "@/lib/observability/after";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { intentWarmProject } from "@/lib/runtime/warm-pool.deps";

// Includes after(): a first project may build its pool; an existing pooled
// box normally wakes in a few seconds. Long-running hosts ignore this cap.
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

/** Best-effort hint from the new-session composer. It answers immediately;
 * Send never depends on it and retains the normal provisioning path. */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;
  after(() => intentWarmProject(owner, id).catch((error: unknown) =>
    console.warn(`Could not pre-warm a session for project ${id}`, error),
  ));
  return new NextResponse(null, { status: 202 });
}
