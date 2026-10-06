import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { getWorkspace, transitionWorkspace } from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { localTransition, parseLocalEvent } from "@/lib/runtime/local-workspace";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Record what the Outrunner app just did to a local workspace on the user's
 * Mac — worktree ready, provisioning failed, stopped, resumed, destroyed. The
 * server cannot reach that machine to find out for itself, so this is the only
 * way a local workspace's status moves. Each change is guarded on the states it
 * may leave, so a stale or repeated report cannot move a workspace backwards.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in as the Runtime owner." }, { status: 401 });
  }

  const event = parseLocalEvent(await request.json().catch(() => null));
  if (!event) {
    return NextResponse.json({ error: "Unknown local workspace event." }, { status: 400 });
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }
  if (workspace.provider !== "desktop") {
    return NextResponse.json({ error: "This workspace does not run locally." }, { status: 409 });
  }

  const { from, patch } = localTransition(event);
  const updated = await transitionWorkspace({ id, from, patch });
  if (!updated) {
    return NextResponse.json(
      { error: `This workspace is ${workspace.status}; refresh and try again.` },
      { status: 409 },
    );
  }
  return NextResponse.json({ workspace: { id: updated.id, status: updated.status } });
}
