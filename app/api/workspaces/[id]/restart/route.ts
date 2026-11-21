import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { readyChatRelaunch, readyRelaunch } from "@/lib/runtime/relaunch.deps";
import { signInFailure } from "@/lib/runtime/session-auth";
import { boxUpgrade } from "@/lib/runtime/session-environment";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";
import { agentChat, requestedChat } from "@/lib/session/chat-target";
import { MAIN_CHAT } from "@/lib/session/chats";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Start a chat's agent again on its conversation: for one that stopped (it
 * crashed, or was killed as its box ran out of memory) or hangs, which Stop
 * can't reach. The box ends the agent's session if it still has one and
 * launches it again, continuing the conversation (its /resume); the step it
 * was on is lost. Signed in and on its model first, as a relaunch is.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });

  const { id } = await context.params;
  const reach = await reachWorkspaceAgent(id, owner.id, {
    label: "Restart",
    needsComputer: "Restarting an agent requires a Runtime Computer provider.",
  });
  if (!reach.ok) return reach.response;
  const { workspace, provider, sandboxId, secret, agent, identity } = reach.reached;
  const named = await requestedChat(request, workspace);
  if (!named.ok) return named.response;
  const chat = named.chat;

  try {
    const upgrade = boxUpgrade(provider, sandboxId, secret, owner.id, workspace.id);
    if (chat.id === MAIN_CHAT) await readyRelaunch(agent, identity, upgrade, workspace, owner.id);
    else await readyChatRelaunch(agent, identity, upgrade, { orgId: workspace.orgId }, chat, owner.id);
    await agent.resumeWorkspace(identity, agentChat(chat));
  } catch (error) {
    const failure = signInFailure(error);
    if (failure) return NextResponse.json(failure, { status: 409 });
    if (error instanceof AgentRequestError && error.error?.message && error.status < 500) {
      return NextResponse.json({ error: error.error.message }, { status: 409 });
    }
    console.error(`Restart: ${workspace.id}'s agent didn't start again`, error);
    return NextResponse.json({ error: "Couldn't restart the agent. Please try again." }, { status: 502 });
  }
  return NextResponse.json({ result: "restarted" });
}
