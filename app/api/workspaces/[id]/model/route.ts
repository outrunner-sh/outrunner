import { NextResponse } from "next/server";

import { getOwner } from "@/lib/auth/owner";
import { neevAiKey } from "@/lib/db/credentials";
import {
  getRuntimeComputerByProject,
  getWorkspace,
  readRuntimeComputerSecret,
} from "@/lib/db/repositories";
import { isSameOriginRequest } from "@/lib/http/guards";
import { NeevAiUnavailableError } from "@/lib/openrouter/keys";
import { StoredKeyUnreadableError } from "@/lib/openrouter/user-key";
import { AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import { DaytonaRuntimeProvider } from "@/lib/runtime/daytona-provider";
import { switchFailure } from "@/lib/runtime/model-switch";
import { providerErrorResponse, resolveProvider } from "@/lib/runtime/resolve";
import { offeredModel, setModelRequest } from "@/lib/runtime/session-models";
import { onlyItsCreator } from "@/lib/runtime/session-guard";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Switch a cloud session to another model from the menu. The agent relaunches
 * Claude on it with the conversation continued. A Neev AI model runs through
 * OpenRouter on the user's key, which is fetched here and goes from this server
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

  const body = (await request.json().catch(() => null)) as { model?: unknown } | null;
  if (!offeredModel(body?.model)) {
    return NextResponse.json({ error: "Choose one of the offered models." }, { status: 400 });
  }

  const { id } = await context.params;
  const workspace = await getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }
  const notCreator = onlyItsCreator(workspace, owner.id, "switch its model");
  if (notCreator) return notCreator;

  const resolution = resolveProvider(workspace);
  if (!resolution.ok) return providerErrorResponse(resolution);
  const provider = resolution.provider;
  if (!(provider instanceof DaytonaRuntimeProvider)) {
    return NextResponse.json(
      { error: "Switching models requires the Daytona runtime provider." },
      { status: 409 },
    );
  }

  const computer = await getRuntimeComputerByProject(workspace.projectId);
  if (!computer || !computer.daytonaSandboxId || computer.status !== "ready") {
    return NextResponse.json({ error: "Runtime Computer is not ready." }, { status: 409 });
  }

  const secret = await readRuntimeComputerSecret(computer.id);
  if (!secret) {
    return NextResponse.json({ error: "Runtime Computer secret missing." }, { status: 500 });
  }

  // The key last: the user's first one is created on OpenRouter, so only for a
  // switch that can go ahead.
  let req;
  try {
    req = await setModelRequest(body?.model, () => neevAiKey(owner.id));
  } catch (error) {
    if (error instanceof NeevAiUnavailableError || error instanceof StoredKeyUnreadableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    console.error(`Model: could not get a Neev AI key for ${owner.id}`, error);
    return NextResponse.json({ error: "Outrunner's models are unavailable right now. Please try again." }, { status: 502 });
  }
  if (!req) {
    return NextResponse.json({ error: "Choose one of the offered models." }, { status: 400 });
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

  try {
    await new AgentClient(target).setModel(identity, req);
  } catch (error) {
    const { status, message } = switchFailure(error);
    if (status >= 500) console.error(`Model: switch failed for ${workspace.id}`, error);
    return NextResponse.json({ error: message }, { status });
  }
  return NextResponse.json({ model: req.model });
}

