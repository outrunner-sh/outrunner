import { NextResponse } from "next/server";
import { isAgentId } from "@/lib/agents/registry";
import { agentConnection, resolveAgentAuth } from "@/lib/agents/resolve";
import { getOwner } from "@/lib/auth/owner";
import { codexModelsFor } from "@/lib/codex/model-catalog.deps";
import { agentAuthStore, modelKey, modelMenu } from "@/lib/db/credentials";
import { getModelLoadout } from "@/lib/db/model-loadout";
import { orgDefaultsFor } from "@/lib/db/org-defaults";
import { isSameOriginRequest } from "@/lib/http/guards";
import { withOrgDefault } from "@/lib/orgs/defaults";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { requireFeature } from "@/lib/runtime/box-features";
import { materializeAttachments } from "@/lib/runtime/materialize-attachments";
import { creationSelection } from "@/lib/runtime/selection";
import { readyBox, sessionAuthClient, signInFailure } from "@/lib/runtime/session-auth";
import { boxUpgrade } from "@/lib/runtime/session-environment";
import { modelGroups, requestedEffort, requestedModel, runsOnOwnAccount, setModelRequest } from "@/lib/runtime/session-models";
import { reachWorkspaceAgent } from "@/lib/runtime/workspace-agent";
import { requestedChat } from "@/lib/session/chat-target";
import { HARNESS_SWITCH_FEATURE, harnessRecorded } from "@/lib/session/harness-switch";
import { recordHarnessSelection } from "@/lib/session/harness-selection.deps";

export const maxDuration = 180;
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const owner = await getOwner();
  if (!owner) return NextResponse.json({ error: "Sign in to change harness." }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || !isAgentId(body.agent) || !isAgentId(body.expectedAgent) || typeof body.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(body.id)) {
    return NextResponse.json({ error: "Choose a harness and retry the change." }, { status: 400 });
  }
  const picked = requestedModel(body);
  const effort = requestedEffort(body);
  if (!picked || effort === null) return NextResponse.json({ error: "Choose an offered model and effort." }, { status: 400 });
  if (body.mode!==undefined && body.mode!=="plan" && body.mode!=="build") return NextResponse.json({error:"Choose plan or build mode."},{status:400});
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.filter((id): id is string => typeof id === "string") : [];
  if (!content && !attachmentIds.length && body.resume !== true) return NextResponse.json({ error: "Send a message or resume the unfinished request." }, { status: 400 });
  const { id } = await context.params;
  const reach = await reachWorkspaceAgent(id, owner.id, { label: "Harness", needsComputer: "Harness switching needs a cloud computer." });
  if (!reach.ok) return reach.response;
  const { workspace, provider, sandboxId, secret, agent, identity } = reach.reached;
  if (workspace.status !== "ready" && workspace.status !== "idle") return NextResponse.json({error:"Resume the workspace before changing harness."},{status:409});
  const named = await requestedChat(request, workspace);
  if (!named.ok) return named.response;
  const chatId = named.chat.id;
  let runtimeAttempted = false;
  try {
    const upgrade = boxUpgrade(provider, sandboxId, secret, owner.id, workspace.id);
    await requireFeature({ features: async () => (await agent.health(identity)).features ?? [], upgrade }, HARNESS_SWITCH_FEATURE, "continue a chat on another harness");
    // Retrying a committed operation needs no fresh catalog or credential: the
    // target already owns its native session and first request.
    const current = (await agent.harnessSelection(identity, chatId)).harness;
    const retry = current?.id === body.id;
    if (retry) {
      runtimeAttempted = true;
      const result = await agent.switchHarness(identity, { id: body.id, agent: current.agent, retry: true }, chatId);
      if (!result.harness) throw new Error("The runtime did not report its harness selection.");
      const recorded = harnessRecorded(result.harness);
      await recordHarnessSelection(id,chatId,result.harness.agent,recorded,result.harness.mode);
      await agent.switchHarness(identity,{ id:result.harness.id,ack:true },chatId);
      return NextResponse.json({ agent:result.harness.agent,recorded,operationId:result.harness.id });
    }
    const store = agentAuthStore(owner.id, workspace.orgId);
    const [menu, mine, org, account, catalog, health] = await Promise.all([
        modelMenu(owner.id, workspace.orgId), getModelLoadout(owner.id), orgDefaultsFor(workspace.orgId),
        agentConnection(store, body.agent), body.agent === "codex" ? codexModelsFor(store) : Promise.resolve([]), agent.health(identity),
      ]);
    const selected = creationSelection(modelGroups({ ...menu, codexModels: catalog }, account.cloud ? [body.agent] : [], body.agent), withOrgDefault(mine, org.defaultModel), { agent: body.agent, model: picked, effort, supported: health.agents });
    const selection = { model: selected.model, effort: selected.effort };
    const auth = await resolveAgentAuth(store, body.agent, "cloud", { ownAccount: runsOnOwnAccount(selection.model) });
    await readyBox(sessionAuthClient(agent, identity, upgrade, chatId), body.agent, auth);
    const model = await setModelRequest(selection.model, (holder) => modelKey(owner.id, holder, workspace.orgId), selection.effort);
    const prompt = body.resume === true ? "" : await materializeAttachments({ provider, sandboxId, worktreePath: workspace.worktreePath, workspaceId: id, attachmentIds, prompt: content });
    runtimeAttempted = true;
    const result = await agent.switchHarness(identity, {
      id: body.id, agent: body.agent, expectedAgent: body.expectedAgent, selection, model,
      auth: auth.credential ?? { kind: "none" }, content: prompt, resume: body.resume === true, mode:body.mode,
    }, chatId);
    if (!result.harness) throw new Error("The runtime did not report its harness selection.");
    await recordHarnessSelection(id, chatId, result.harness.agent, harnessRecorded(result.harness),result.harness.mode);
    await agent.switchHarness(identity,{ id:result.harness.id,ack:true },chatId);
    return NextResponse.json({ agent: result.harness.agent, recorded: harnessRecorded(result.harness), operationId: result.harness.id });
  } catch (error) {
    const failure = signInFailure(error);
    let sourceUnchanged = !runtimeAttempted;
    if (runtimeAttempted) {
      try { sourceUnchanged = (await agent.harnessSelection(identity, chatId)).harness?.id !== body.id; } catch { /* an unclear transition must be retried */ }
    }
    if (failure) return NextResponse.json({ ...failure, sourceUnchanged }, { status: 409 });
    return NextResponse.json({ error: error instanceof AgentRequestError ? error.error?.message ?? "The switch is still settling. Retry with the same selection." : error instanceof Error ? error.message : "Couldn't change harness. Your draft is still here.", sourceUnchanged }, { status: 409 });
  }
}
