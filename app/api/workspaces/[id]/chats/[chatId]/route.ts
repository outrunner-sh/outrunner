import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { deleteChatRow, renameChat } from "@/lib/db/chats";
import { getWorkspace } from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";
import { chatNamed } from "@/lib/session/chat-target";
import { chatName, MAIN_CHAT } from "@/lib/session/chats";

type RouteContext = { params: Promise<{ id: string; chatId: string }> };

/** Rename one of the session's chats, its main one too. */
export async function PATCH(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  const name = chatName(body?.name);
  if (!name) return NextResponse.json({ error: "A chat's name is 1 to 80 characters." }, { status: 400 });

  const { id, chatId } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  const named = await chatNamed(chatId, workspace);
  if (!named.ok) return named.response;
  await renameChat(workspace.id, named.chat.id, name);
  return NextResponse.json({ chat: { ...named.chat, name } });
}

/**
 * Delete one of the session's chats: its agent is stopped (its turn with
 * it) and the box forgets it. The main chat is the session, which is
 * archived or deleted as a whole. A box that can't be reached (asleep) still
 * loses the chat from the list; what it has of it goes with the session.
 */
export async function DELETE(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  const { id, chatId } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  const named = await chatNamed(chatId, workspace);
  if (!named.ok) return named.response;
  if (named.chat.id === MAIN_CHAT) {
    return NextResponse.json({ error: "The main chat is the session itself: archive or delete the session instead." }, { status: 400 });
  }
  const reach = await reachWorkspaceAgent(id, owner.id, { label: "Chat delete", needsComputer: "" });
  if (reach.ok) {
    const { agent, identity } = reach.reached;
    await agent.deleteChat(identity, named.chat.id).catch((error: unknown) =>
      console.warn(`Chat delete: the box kept ${named.chat.id} of ${workspace.id}`, error),
    );
  }
  await deleteChatRow(workspace.id, named.chat.id);
  return NextResponse.json({ result: "deleted" });
}
