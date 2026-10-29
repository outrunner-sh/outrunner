import { NextResponse } from "next/server";

import { AGENTS } from "@/lib/agents/registry";
import { getOwner } from "@/lib/auth/owner";
import { recordChatModel } from "@/lib/db/chats";
import { agentAuthStore, modelKey } from "@/lib/db/credentials";
import {
  getWorkspaceComputer,
  getWorkspace,
  readRuntimeComputerSecret,
  recordWorkspaceModel,
} from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { modelKeyErrorResponse } from "@/lib/http/model-key-errors";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { AGENT_FEATURE_CODEX_GATEWAY } from "@/lib/runtime/agent-protocol";
import { requireFeature } from "@/lib/runtime/box-features";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { switchFailure } from "@/lib/runtime/model-switch";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";
import { agentChat, requestedChat } from "@/lib/session/chat-target";
import { boxUpgrade } from "@/lib/runtime/session-environment";
import { sessionAuthClient, signInFailure, signInSession } from "@/lib/runtime/session-auth";
import {
  agentOf,
  agentsFor,
  checkEffortApplied,
  onCodexGateway,
  requestedEffort,
  requestedModel,
  runsOnOwnAccount,
  setModelRequest,
} from "@/lib/runtime/session-models";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Switch a cloud session to another model from the menu. The agent relaunches
 * Claude on it with the conversation continued. One of Outrunner's models runs
 * through OpenRouter on the user's key, which is fetched here and goes from this server
 * to the box: it never reaches the browser.
 */
export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Sign in to switch models." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { provider?: unknown; model?: unknown; key?: unknown; effort?: unknown }
    | null;
  const model = requestedModel(body);
  if (!model) {
    return NextResponse.json({ error: "Choose one of the offered models." }, { status: 400 });
  }
  // None: the model's own.
  const effort = requestedEffort(body);
  if (effort === null) {
    return NextResponse.json({ error: "Choose one of the offered efforts." }, { status: 400 });
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }
  // The chat it switches (?chat=), its main one unless it names another.
  const named = await requestedChat(request, workspace);
  if (!named.ok) return named.response;
  const chatAgent = named.chat.agent;
  const chat = agentChat(named.chat);
  // A chat keeps its agent: its conversation is that agent's.
  if (!agentsFor(model.provider).includes(chatAgent)) {
    return NextResponse.json(
      { error: `This chat runs ${AGENTS[chatAgent].label}. Fork it to use ${AGENTS[agentOf(model.provider)].label}.` },
      { status: 409 },
    );
  }

  const resolution = resolveProvider(workspace);
  if (!resolution.ok) return providerErrorResponse(resolution);
  const provider = resolution.provider;
  if (!isComputerProvider(provider)) {
    return NextResponse.json(
      { error: "Switching models requires a cloud sandbox provider." },
      { status: 409 },
    );
  }

  const computer = await getWorkspaceComputer(workspace);
  if (!computer || !computer.daytonaSandboxId || computer.status !== "ready") {
    return NextResponse.json({ error: "Runtime Computer is not ready." }, { status: 409 });
  }

  const secret = await readRuntimeComputerSecret(computer.id);
  if (!secret) {
    return NextResponse.json({ error: "Runtime Computer secret missing." }, { status: 500 });
  }

  // The key last: a user's first key for Outrunner's models is created on
  // OpenRouter, so only for a switch that can go ahead.
  let req;
  try {
    req = await setModelRequest(model, (holder) => modelKey(owner.id, holder, workspace.orgId), effort);
  } catch (error) {
    return modelKeyErrorResponse(error, `Model: could not get the ${model.provider} key of ${owner.id}`);
  }

  let target;
  try {
    target = await provider.agentTarget(computer.daytonaSandboxId, secret);
  } catch (error) {
    console.error(`Model: agentTarget failed for ${workspace.id}`, error);
    return NextResponse.json({ error: "Could not reach the Runtime Computer." }, { status: 503 });
  }

  const identity: WorkspaceIdentity = {
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    computerId: computer.id,
    userId: owner.id,
  };

  const agent = new AgentClient(target);
  try {
    // The switch relaunches the session: signed in as the user picks now, so
    // a key replaced since is the one it relaunches on.
    const upgrade = boxUpgrade(provider, computer.daytonaSandboxId, secret, owner.id, workspace.id);
    // An agent from before Codex ran through a gateway would refuse the model.
    // Checked before signing in, which may take the session's own key away
    // (a model on Outrunner's key needs none): a switch refused here must
    // leave the session as it was.
    if (onCodexGateway(chatAgent, model)) {
      const features = { features: async () => (await agent.health(identity)).features ?? [], upgrade };
      await requireFeature(features, AGENT_FEATURE_CODEX_GATEWAY, "run Codex on Outrunner's models");
    }
    await signInSession(
      sessionAuthClient(agent, identity, upgrade, chat),
      chatAgent,
      agentAuthStore(owner.id, workspace.orgId),
      runsOnOwnAccount(model),
    );
  } catch (error) {
    const failure = signInFailure(error);
    if (failure) return NextResponse.json(failure, { status: 409 });
    console.error(`Model: signing ${workspace.id} in failed`, error);
    return NextResponse.json({ error: "Couldn't switch models. Please try again." }, { status: 502 });
  }

  try {
    checkEffortApplied(req, await agent.setModel(identity, req, chat));
  } catch (error) {
    const { status, message } = switchFailure(error, model);
    if (status >= 500) console.error(`Model: switch failed for ${workspace.id}`, error);
    return NextResponse.json({ error: message }, { status });
  }
  // So its next relaunch goes back on it, its key fetched again.
  if (chat) await recordChatModel(workspace.id, chat, { model, effort: req.effort ?? null });
  else await recordWorkspaceModel(workspace.id, { model, effort: req.effort ?? null });
  return NextResponse.json({ model: req.model, effort: req.effort ?? null });
}

