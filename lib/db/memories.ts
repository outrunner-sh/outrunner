/**
 * Long-term memory in the database (20261103111000_memories.sql), as the
 * store lib/memory/actions.ts works on. Service role only: the table has no
 * policies, and the actions check who may do what. Before the migration
 * applies, a read finds none.
 */

import { isUuid } from "@/lib/ids";
import type { Memory, MemoryStore } from "@/lib/memory/actions";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

const COLUMNS = "id, user_id, org_id, body, workspace_id, created_at";

type Row = { id: string; user_id: string; org_id: string | null; body: string; workspace_id: string | null; created_at: string };

function memoryOf(row: Row): Memory {
  return {
    id: row.id,
    scope: row.org_id ? "org" : "personal",
    userId: row.user_id,
    orgId: row.org_id,
    body: row.body,
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
  };
}

export const memoryStore: MemoryStore = {
  async list(where) {
    const query = createSupabaseAdminClient().from("memories").select(COLUMNS);
    const scoped = "orgId" in where ? query.eq("org_id", where.orgId) : query.eq("user_id", where.userId).is("org_id", null);
    const { data, error } = await scoped.order("created_at", { ascending: false }).limit(1000);
    if (error && probeStatus(error) === "missing") return [];
    if (error) throw error;
    return (data ?? []).map((row) => memoryOf(row as Row));
  },

  async get(id) {
    if (!isUuid(id)) return null;
    const { data, error } = await createSupabaseAdminClient().from("memories").select(COLUMNS).eq("id", id).maybeSingle();
    if (error && probeStatus(error) === "missing") return null;
    if (error) throw error;
    return data ? memoryOf(data as Row) : null;
  },

  async insert(row) {
    const { data, error } = await createSupabaseAdminClient()
      .from("memories")
      .insert({ user_id: row.userId, org_id: row.orgId, body: row.body, workspace_id: row.workspaceId })
      .select(COLUMNS)
      .single();
    if (error) throw error;
    return memoryOf(data as Row);
  },

  async remove(id) {
    const { data, error } = await createSupabaseAdminClient().from("memories").delete().eq("id", id).select("id");
    if (error) throw error;
    return (data ?? []).length > 0;
  },
};
