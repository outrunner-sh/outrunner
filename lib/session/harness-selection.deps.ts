import type { AgentId } from "@/lib/agents/registry";
import { AgentRequestError, type AgentClient, type WorkspaceIdentity } from "@/lib/runtime/agent-client";
import type { RecordedModel } from "@/lib/runtime/session-models";
import type { SessionMode } from "@/lib/runtime/agent-protocol";
import { harnessRecorded } from "@/lib/session/harness-switch";
import { MAIN_CHAT } from "@/lib/session/chats";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

/** Checked persistence: a harness selection determines where credentials go
 * on wake, so a failed write must be reported and retried. The session's row
 * is the server's to write (20261105100000), so through the admin client,
 * scoped to its owner. */
export async function recordHarnessSelection(workspaceId: string, ownerId: string, chatId: string, agent: AgentId, selection: RecordedModel, mode?: SessionMode): Promise<void> {
  const patch = { agent, model_provider: selection.model.provider, model_id: selection.model.id, model_effort: selection.effort };
  const query = chatId === MAIN_CHAT
    ? createSupabaseAdminClient().from("workspaces").update({ ...patch,...(mode && {session_mode:mode}) }).eq("id", workspaceId).eq("owner_id", ownerId)
    : (await createSupabaseServerClient()).from("workspace_chats").update(patch).eq("workspace_id", workspaceId).eq("id", chatId);
  const { data, error } = await query.select("id").single();
  if (error || !data) throw new Error("The harness changed, but its selection could not be saved. Retry the switch before archiving.", { cause: error });
}

/** A lost response/database outage must not sign the old vendor in over the
 * runtime's committed target. Older agents have no selection endpoint. */
export async function reconcileHarnessSelection(client: AgentClient, identity: WorkspaceIdentity,
  current: { agent: AgentId; model: RecordedModel | null }, ownerId: string, chatId = MAIN_CHAT) {
  let status;
  try { status = await client.harnessSelection(identity, chatId); }
  catch (error) {
    if (error instanceof AgentRequestError && error.status === 404 && !error.error) return current;
    throw error;
  }
  const state = status.harness;
  if (!state || (state.agent === current.agent && state.saved !== false)) return current;
  const model = harnessRecorded(state);
  await recordHarnessSelection(identity.workspaceId, ownerId, chatId, state.agent, model, state.mode);
  await client.switchHarness(identity,{ id:state.id,ack:true },chatId);
  return { agent: state.agent, model };
}
