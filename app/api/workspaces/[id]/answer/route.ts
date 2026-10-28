import { after, NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { AnswerRequest } from "@/lib/runtime/agent-protocol";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";
import { watchSent } from "@/lib/session/watch";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Answer the questions a cloud session's agent is waiting on: the question
 * card that stands in for the composer. The agent hands the answer to the
 * agent's ask_user call as its result.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const parsed = AnswerRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "That answer isn't one the question takes." }, { status: 400 });
  }

  const { id } = await context.params;
  const reach = await reachWorkspaceAgent(id, owner.id, {
    label: "Answer",
    needsComputer: "Answering a question requires a Runtime Computer provider.",
  });
  if (!reach.ok) return reach.response;
  const { workspace, agent, identity } = reach.reached;

  try {
    await agent.answer(identity, parsed.data);
  } catch (error) {
    // The question is over (answered, given up, or from before a restart), or
    // the answer doesn't fit it: the agent's message says which.
    if (error instanceof AgentRequestError && error.error?.code === "CONFLICT") {
      return NextResponse.json({ error: error.error.message }, { status: 409 });
    }
    if (error instanceof AgentRequestError && error.error?.code === "INVALID_REQUEST") {
      return NextResponse.json({ error: error.error.message }, { status: 400 });
    }
    console.error(`Answer: failed for ${workspace.id}`, error);
    return NextResponse.json({ error: "Couldn't send your answer. Please try again." }, { status: 502 });
  }
  // No longer waiting on the user: working again, and watched.
  after(() => watchSent(workspace.id, workspace.ownerId));
  return NextResponse.json({ result: "answered" });
}
