import { NextResponse } from "next/server";

import { AGENTS, isAgentId } from "@/lib/agents/registry";
import { getOwner } from "@/lib/auth/owner";
import { deleteChatRow, insertChat, listChats } from "@/lib/db/chats";
import { getWorkspace } from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { AGENT_FEATURE_CHATS } from "@/lib/runtime/agent-protocol";
import { requireFeature } from "@/lib/runtime/box-features";
import { readyChatRelaunch } from "@/lib/runtime/relaunch.deps";
import { OutdatedComputerError, signInFailure } from "@/lib/runtime/session-auth";
import { boxUpgrade } from "@/lib/runtime/session-environment";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";
import { chatNamed } from "@/lib/session/chat-target";
import { chatName, defaultChatName, MAIN_CHAT, mainChatOf, orderedChats } from "@/lib/session/chats";

type RouteContext = { params: Promise<{ id: string }> };

/** The session's chats, its main one first. */
export async function GET(_request: Request, context: RouteContext) {
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  return NextResponse.json({ chats: orderedChats(mainChatOf(workspace), await listChats(workspace.id)) });
}

/**
 * Start a chat in the session, on its box beside the others: afresh, or a
 * fork of one of its chats (`from`), on the same agent or the other, which
 * carries that chat's conversation over (runtime-agent chats.go); or a side
 * chat about one (`side`), for a quick question that leaves its turn alone.
 * Nothing is sent: the page sends the first prompt, as it does any.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as
    | { agent?: unknown; from?: unknown; side?: unknown; name?: unknown; question?: unknown }
    | null;
  if (body?.agent !== undefined && !isAgentId(body.agent)) {
    return NextResponse.json({ error: "Choose Claude Code or Codex." }, { status: 400 });
  }
  if (body?.name !== undefined && chatName(body.name) === null) {
    return NextResponse.json({ error: "A chat's name is 1 to 80 characters." }, { status: 400 });
  }
  const side = body?.side === true;

  const { id } = await context.params;
  const reach = await reachWorkspaceAgent(id, owner.id, {
    label: "Chat",
    needsComputer: "Chats need a Runtime Computer provider.",
  });
  if (!reach.ok) return reach.response;
  const { workspace, provider, sandboxId, secret, agent, identity } = reach.reached;
  if (workspace.kind === "mission") {
    return NextResponse.json({ error: "A Mission runs in one chat." }, { status: 409 });
  }

  // The chat it forks, if any: a side chat is always about one.
  let from = null;
  if (body?.from !== undefined || side) {
    const named = await chatNamed(body?.from ?? MAIN_CHAT, workspace);
    if (!named.ok) return named.response;
    from = named.chat;
  }
  const chatAgent = isAgentId(body?.agent) ? body.agent : (from?.agent ?? workspace.agent);
  const existing = await listChats(workspace.id);
  const name =
    chatName(body?.name) ??
    defaultChatName(existing, { ...(from && { from }), side, question: typeof body?.question === "string" ? body.question : undefined });

  const upgrade = boxUpgrade(provider, sandboxId, secret, owner.id, workspace.id);
  try {
    const health = { features: async () => (await agent.health(identity)).features ?? [], upgrade };
    await requireFeature(health, AGENT_FEATURE_CHATS, "run several chats in a session");
    const agents = (await agent.health(identity)).agents ?? ["claude"];
    if (!agents.includes(chatAgent)) {
      return NextResponse.json({ error: `This session's computer can't run ${AGENTS[chatAgent].label}.` }, { status: 409 });
    }
  } catch (error) {
    if (error instanceof OutdatedComputerError) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error(`Chat: couldn't ready ${workspace.id}'s box for chats`, error);
    return NextResponse.json({ error: "Couldn't reach the Runtime Computer. Try again." }, { status: 502 });
  }

  // A chat on its source's agent goes on its model; on another, on that
  // agent's own default until the user picks one.
  const source = from ?? mainChatOf(workspace);
  const chat = await insertChat({
    id: crypto.randomUUID(),
    workspaceId: workspace.id,
    ownerId: owner.id,
    name,
    agent: chatAgent,
    kind: side ? "side" : "chat",
    forkedFrom: from?.id ?? null,
    model: source.agent === chatAgent ? source.model : null,
  });
  try {
    await agent.createChat(identity, {
      chatId: chat.id,
      agent: chatAgent,
      ...(from && { from: from.id, fromName: from.name }),
      ...(side && { side }),
      noStart: true,
    });
    await readyChatRelaunch(agent, identity, upgrade, workspace, chat, owner.id);
    await agent.startWorkspace(identity, chat.id);
  } catch (error) {
    // Not made, so not listed: the box forgets what it had of it.
    await agent.deleteChat(identity, chat.id).catch(() => {});
    await deleteChatRow(workspace.id, chat.id).catch((cleanup: unknown) =>
      console.warn(`Chat: couldn't forget ${chat.id} of ${workspace.id}`, cleanup),
    );
    const failure = signInFailure(error);
    if (failure) return NextResponse.json(failure, { status: 409 });
    if (error instanceof AgentRequestError && (error.error?.code === "UNSUPPORTED" || error.error?.code === "INVALID_REQUEST")) {
      return NextResponse.json({ error: error.error.message }, { status: 409 });
    }
    console.error(`Chat: couldn't start a chat in ${workspace.id}`, error);
    return NextResponse.json({ error: "Couldn't start the chat. Please try again." }, { status: 502 });
  }
  return NextResponse.json({ chat }, { status: 201 });
}
