import { after, NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { recordWorkspaceMode } from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { AGENT_FEATURE_PLAN_MODE } from "@/lib/runtime/agent-protocol";
import { requireFeature } from "@/lib/runtime/box-features";
import { OutdatedComputerError } from "@/lib/runtime/session-auth";
import { boxUpgrade } from "@/lib/runtime/session-environment";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";
import { agentChat, requestedChat } from "@/lib/session/chat-target";
import { watchSent } from "@/lib/session/watch";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Approve the plan a cloud session's agent waits on: the plan card's Approve.
 * The agent picks the session's build mode in Claude's own plan menu, so
 * Claude goes on in the same turn, or, where there is no such menu (Codex),
 * sends the approval as a prompt in build mode. The session builds from here,
 * so its row says so.
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
    label: "Plan",
    needsComputer: "Plans need a Runtime Computer provider.",
  });
  if (!reach.ok) return reach.response;
  const { workspace, provider, sandboxId, secret, agent, identity } = reach.reached;
  const named = await requestedChat(request, workspace);
  if (!named.ok) return named.response;
  const chat = agentChat(named.chat);

  try {
    let approved;
    try {
      approved = await agent.approvePlan(identity, chat);
    } catch (error) {
      // No such route: an agent from before plans, brought up to this one's,
      // then asked again. Asked only then, not on every click.
      if (!(error instanceof AgentRequestError && error.status === 404 && !error.error)) throw error;
      await requireFeature(
        {
          features: async () => (await agent.health(identity)).features ?? [],
          upgrade: boxUpgrade(provider, sandboxId, secret, owner.id, workspace.id),
        },
        AGENT_FEATURE_PLAN_MODE,
        "approve a plan",
      );
      approved = await agent.approvePlan(identity, chat);
    }
    // Approved, it builds; answered already, it is in the mode its agent read
    // off its screen. The row follows, so the session opens in it again.
    const mode = approved.result === "answered" ? (approved.mode ?? "build") : "build";
    if (workspace.mode !== mode) await recordWorkspaceMode(workspace.id, mode);
    // An approval puts the session to work (Claude builds in the same turn;
    // Codex takes it as a prompt): working for every client at once, and
    // watched until the turn ends (lib/session/watch.ts), as a sent prompt
    // is. "answered" put nothing to work, so a session idle at its box isn't
    // marked working.
    if (approved.result === "approved" && !chat) after(() => watchSent(workspace.id, workspace.ownerId));
    return NextResponse.json(approved);
  } catch (error) {
    if (error instanceof OutdatedComputerError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // Mid-turn, or a menu that didn't take the pick: the agent's own words
    // say which.
    if (error instanceof AgentRequestError && (error.error?.code === "CONFLICT" || error.error?.code === "UNSUPPORTED")) {
      return NextResponse.json({ error: error.error.message }, { status: 409 });
    }
    console.error(`Plan: couldn't approve ${workspace.id}'s plan`, error);
    return NextResponse.json({ error: "Couldn't approve the plan. Try again." }, { status: 502 });
  }
}
