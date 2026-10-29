import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A cloud session's Canvas (lib/session/canvas.ts): the files its agent put
 * in the folder for the user to see, newest first, read off its box (the
 * agent's GET /workspaces/{id}/canvas). Its owner's alone. An agent from
 * before the Canvas answers `{ files: [], outdated: true }`: the box gets it
 * with its next upgrade, not for a glance at a panel.
 */
export async function GET(_request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;
  const reach = await reachWorkspaceAgent(id, owner.id, {
    label: "Canvas",
    needsComputer: "The Canvas needs a Runtime Computer provider.",
  });
  if (!reach.ok) return reach.response;
  const { workspace, agent, identity } = reach.reached;
  if (workspace.ownerId !== owner.id) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });

  try {
    return NextResponse.json(await agent.listCanvas(identity), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AgentRequestError && error.status === 404 && !error.error) {
      return NextResponse.json({ dir: null, files: [], outdated: true });
    }
    console.warn(`Canvas: couldn't list ${workspace.id}'s`, error);
    return NextResponse.json({ error: "Couldn't read this session's Canvas." }, { status: 502 });
  }
}
