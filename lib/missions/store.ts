/**
 * Missions in the database, read and written with the service role: the
 * tools have checked the Mission's token (lib/missions/token.ts) and scope
 * everything to that Mission themselves (lib/missions/tools.ts), and the
 * tick has no user to read as.
 */

import { toWorkspace } from "@/lib/db/mappers";
import type { MissionTokenStore } from "@/lib/missions/token";
import type { Workspace } from "@/lib/runtime/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

function db() {
  return createSupabaseAdminClient();
}

export const missionTokens: MissionTokenStore = {
  async save(missionId, tokenHash) {
    const { error } = await db()
      .from("mission_tokens")
      .upsert({ mission_id: missionId, token_hash: tokenHash, minted_at: new Date().toISOString() }, { onConflict: "mission_id" });
    if (error) throw error;
  },
  async find(tokenHash) {
    const { data, error } = await db().from("mission_tokens").select("mission_id").eq("token_hash", tokenHash).maybeSingle();
    if (error) throw error;
    return data?.mission_id ?? null;
  },
};

/** Any session by id, whoever's: the callers check whose it is. */
export async function sessionById(id: string): Promise<Workspace | null> {
  const { data, error } = await db().from("workspaces").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toWorkspace(data) : null;
}

/** The Mission's Runners, newest first; deleted ones left out. */
export async function runnersOf(missionId: string): Promise<Workspace[]> {
  const { data, error } = await db()
    .from("workspaces")
    .select("*")
    .eq("parent_mission_id", missionId)
    .neq("status", "destroyed")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(toWorkspace);
}

export async function readNotes(missionId: string): Promise<{ body: string; updatedAt: string | null }> {
  const { data, error } = await db().from("mission_notes").select("body, updated_at").eq("mission_id", missionId).maybeSingle();
  if (error) throw error;
  return { body: data?.body ?? "", updatedAt: data?.updated_at ?? null };
}

export async function writeNotes(missionId: string, body: string): Promise<void> {
  const { error } = await db()
    .from("mission_notes")
    .upsert({ mission_id: missionId, body }, { onConflict: "mission_id" });
  if (error) throw error;
}

/** Hold a message for a Runner until its turn ends. */
export async function queueMessage(missionId: string, runnerId: string, content: string): Promise<void> {
  const { error } = await db().from("mission_queued_messages").insert({ mission_id: missionId, runner_id: runnerId, content });
  if (error) throw error;
}

/**
 * The Runner's next held message, taken: marked sent first, so a watch and a
 * tick that both see the turn end don't both send it. Null when none waits.
 */
export async function takeQueuedMessage(runnerId: string): Promise<{ id: string; content: string } | null> {
  const { data: next, error } = await db()
    .from("mission_queued_messages")
    .select("id")
    .eq("runner_id", runnerId)
    .is("sent_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!next) return null;
  const { data: taken, error: takeError } = await db()
    .from("mission_queued_messages")
    .update({ sent_at: new Date().toISOString() })
    .eq("id", next.id)
    .is("sent_at", null)
    .select("id, content")
    .maybeSingle();
  if (takeError) throw takeError;
  return taken ?? null;
}

/** Give a taken message back, when it couldn't be sent. */
export async function returnQueuedMessage(id: string): Promise<void> {
  await db().from("mission_queued_messages").update({ sent_at: null }).eq("id", id);
}

/** How many messages wait for each of these Runners. */
export async function queuedCounts(runnerIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (runnerIds.length === 0) return counts;
  const { data, error } = await db()
    .from("mission_queued_messages")
    .select("runner_id")
    .in("runner_id", runnerIds)
    .is("sent_at", null);
  if (error) throw error;
  for (const row of data ?? []) counts.set(row.runner_id, (counts.get(row.runner_id) ?? 0) + 1);
  return counts;
}

/** Keep a Runner's brief. */
export async function saveBrief(missionId: string, runnerId: string, brief: string): Promise<void> {
  const { error } = await db().from("mission_runner_briefs").upsert({ runner_id: runnerId, mission_id: missionId, brief }, { onConflict: "runner_id" });
  if (error) throw error;
}
