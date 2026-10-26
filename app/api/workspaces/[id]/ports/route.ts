import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { opensInBrowser } from "@/lib/runtime/types";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The servers running on a cloud session's box (a dev server, an API), for
 * its Environment panel to offer: POST …/ports/[port] opens one. Read only,
 * so no Origin check: a GET carries the owner's cookie, and answers only them.
 */
export async function GET(_request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const { id } = await context.params;
  const reach = await reachWorkspaceAgent(id, owner.id, {
    label: "Ports",
    needsComputer: "Previews run on Outrunner's cloud computers.",
  });
  if (!reach.ok) return reach.response;
  const { workspace, agent, identity } = reach.reached;
  // Nothing to offer where a preview can't open.
  if (!opensInBrowser(workspace.provider)) return NextResponse.json({ ports: [] });

  try {
    return NextResponse.json({ ports: await agent.listPorts(identity) });
  } catch (error) {
    // No such route: an agent from before previews. Not upgraded from here (a
    // GET mustn't restart the agent); opening the editor or relaunching the
    // session brings it up to date, and the list shows then.
    if (error instanceof AgentRequestError && error.status === 404 && !error.error) {
      return NextResponse.json({ ports: [], outdated: true });
    }
    console.error(`Ports: failed for ${workspace.id}`, error);
    return NextResponse.json({ error: "Couldn't read this session's servers." }, { status: 502 });
  }
}
