import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Stop the turn a cloud session is running: the composer's stop button. The
 * agent presses Escape in the session, as the user would in its terminal, and
 * answers once the turn has stopped.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }

  const { id } = await context.params;
  const reach = await reachWorkspaceAgent(id, owner.id, {
    label: "Interrupt",
    needsComputer: "Stopping a turn requires a Runtime Computer provider.",
  });
  if (!reach.ok) return reach.response;
  const { workspace, agent, identity } = reach.reached;

  try {
    await agent.interrupt(identity);
  } catch (error) {
    // The agent couldn't confirm the stop: its message says to try again.
    if (error instanceof AgentRequestError && error.error?.code === "CONFLICT") {
      return NextResponse.json({ error: error.error.message }, { status: 409 });
    }
    // No route: an agent deployed before stopping.
    if (error instanceof AgentRequestError && error.status === 404 && !error.error) {
      return NextResponse.json(
        { error: "This project's cloud computer runs an older Outrunner that can't stop a turn." },
        { status: 409 },
      );
    }
    console.error(`Interrupt: failed for ${workspace.id}`, error);
    return NextResponse.json({ error: "Couldn't stop the turn. Please try again." }, { status: 502 });
  }
  return NextResponse.json({ result: "interrupted" });
}
