import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { AGENT_FEATURE_REWIND, RewindRequest } from "@/lib/runtime/agent-protocol";
import { requireFeature } from "@/lib/runtime/box-features";
import { OutdatedComputerError } from "@/lib/runtime/session-auth";
import { boxUpgrade } from "@/lib/runtime/session-environment";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";
import { agentChat, requestedChat } from "@/lib/session/chat-target";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Edit a sent message: the chat's conversation is cut back to just before
 * it (the message and everything after it gone), for the page to send the
 * edit in its place, in the same chat. Its agent continues from there: Claude
 * its own session, Codex a new one handed the conversation before it. Files
 * and git state are not rolled back. Refused while the agent works.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const parsed = RewindRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Name the message to edit." }, { status: 400 });

  const { id } = await context.params;
  const reach = await reachWorkspaceAgent(id, owner.id, {
    label: "Edit",
    needsComputer: "Editing a message requires a Runtime Computer provider.",
  });
  if (!reach.ok) return reach.response;
  const { workspace, provider, sandboxId, secret, agent, identity } = reach.reached;
  const named = await requestedChat(request, workspace);
  if (!named.ok) return named.response;

  try {
    await requireFeature(
      {
        features: async () => (await agent.health(identity)).features ?? [],
        upgrade: boxUpgrade(provider, sandboxId, secret, owner.id, workspace.id),
      },
      AGENT_FEATURE_REWIND,
      "edit a sent message",
    );
    return NextResponse.json(await agent.rewind(identity, parsed.data, agentChat(named.chat)));
  } catch (error) {
    if (error instanceof OutdatedComputerError) return NextResponse.json({ error: error.message }, { status: 409 });
    // Mid-turn, or not a prompt: the agent's words say which.
    if (error instanceof AgentRequestError && (error.error?.code === "CONFLICT" || error.error?.code === "UNSUPPORTED")) {
      return NextResponse.json({ error: error.error.message }, { status: 409 });
    }
    if (error instanceof AgentRequestError && error.error?.code === "INVALID_REQUEST") {
      return NextResponse.json({ error: error.error.message, code: "INVALID_REQUEST" }, { status: 400 });
    }
    console.error(`Edit: rewinding ${workspace.id} failed`, error);
    return NextResponse.json({ error: "Couldn't edit the message. Please try again." }, { status: 502 });
  }
}
