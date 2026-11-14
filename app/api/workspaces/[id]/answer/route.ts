import { NextResponse } from "next/server";

import { after } from "@/lib/observability/after";

import { getOwner } from "@/lib/auth/owner";
import { isSameOriginRequest } from "@/lib/http/guards";
import { deliverAnswer } from "@/lib/runtime/answer-question";
import { CardAnswer } from "@/lib/runtime/pending-question";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";
import { agentChat, requestedChat } from "@/lib/session/chat-target";
import { watchSent } from "@/lib/session/watch";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Answer the questions a cloud session's agent is waiting on: the question
 * card that stands in for the composer. The agent hands the answer to the
 * agent's ask_user call as its result.
 *
 * An agent that names its calls (AGENT_FEATURE_ASK_CALL_IDENTITY) gets the
 * answer for the exact call: the one a caller names (callId, launchEpoch),
 * or the one the agent verified is the card's transcript call (toolUseId).
 * Anything else, an older agent, a call not yet verified, is answered by
 * its questions' text, as before. A caller naming a call of an agent that
 * can't take one is refused: that agent would answer by text alone.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to Outrunner first." }, { status: 401 });
  }
  const parsed = CardAnswer.safeParse(await request.json().catch(() => null));
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
  const named = await requestedChat(request, workspace);
  if (!named.ok) return named.response;
  const chat = agentChat(named.chat);

  const outcome = await deliverAnswer(
    {
      health: () => agent.health(identity),
      pendingQuestions: () => agent.pendingQuestions(identity, chat),
      answer: (req) => agent.answer(identity, req, chat),
    },
    parsed.data,
  );
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }
  // No longer waiting on the user: working again, and watched.
  // The sidebar follows the main chat's turn: a chat's own is its page's.
  if (!chat) after(() => watchSent(workspace.id, workspace.ownerId), { where: "watch-sent", workspaceId: workspace.id });
  return NextResponse.json({ result: "answered", ...(outcome.replayed && { replayed: true }) });
}
