import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { AGENT_FEATURE_COMPACT } from "@/lib/runtime/agent-protocol";
import { requireFeature } from "@/lib/runtime/box-features";
import { OutdatedComputerError } from "@/lib/runtime/session-auth";
import { boxUpgrade } from "@/lib/runtime/session-environment";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";
import { agentChat, requestedChat } from "@/lib/session/chat-target";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Compact a cloud session's conversation: the composer's /compact. The agent
 * types /compact into the session, as the user would in its terminal, and
 * answers once the compaction is under way; the session goes on, and the
 * conversation stream shows the compaction once its agent has written it.
 * An agent from before compacting is upgraded first, as for the editor.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { instructions?: unknown } | null;
  const instructions = typeof body?.instructions === "string" ? body.instructions.trim().slice(0, 2000) : "";

  const { id } = await context.params;
  const reach = await reachWorkspaceAgent(id, owner.id, {
    label: "Compact",
    needsComputer: "Compacting a conversation requires a Runtime Computer provider.",
  });
  if (!reach.ok) return reach.response;
  const { workspace, provider, sandboxId, secret, agent, identity } = reach.reached;
  const named = await requestedChat(request, workspace);
  if (!named.ok) return named.response;
  const chat = agentChat(named.chat);

  try {
    try {
      await agent.compact(identity, instructions ? { instructions } : {}, chat);
    } catch (error) {
      // No such route: an agent from before compacting, brought up to this
      // one's, then asked again.
      if (!(error instanceof AgentRequestError && error.status === 404 && !error.error)) throw error;
      await requireFeature(
        {
          features: async () => (await agent.health(identity)).features ?? [],
          upgrade: boxUpgrade(provider, sandboxId, secret, owner.id, workspace.id),
        },
        AGENT_FEATURE_COMPACT,
        "compact a conversation",
      );
      await agent.compact(identity, instructions ? { instructions } : {}, chat);
    }
  } catch (error) {
    if (error instanceof OutdatedComputerError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // Mid-turn, a question showing, or an engine that can't: the agent says.
    if (error instanceof AgentRequestError && error.error && error.status !== 404) {
      return NextResponse.json({ error: error.error.message }, { status: error.status === 500 ? 502 : 409 });
    }
    if (error instanceof AgentRequestError && error.status === 404) {
      return NextResponse.json({ error: "This session isn't running on its computer any more." }, { status: 410 });
    }
    console.error(`Compact: failed for ${workspace.id}`, error);
    return NextResponse.json({ error: "Couldn't compact the conversation. Please try again." }, { status: 502 });
  }
  return NextResponse.json({ result: "compacting" });
}
