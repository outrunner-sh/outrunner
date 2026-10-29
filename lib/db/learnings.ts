/**
 * Learnings in the database (20261103110000_learnings.sql), as the store
 * lib/learnings/actions.ts works on. Service role only: the table has no
 * policies, and the actions check who may do what. Before the migration
 * applies, a read finds none and a write is refused. Settings routes explain
 * that the database isn't updated (lib/http/database-not-updated.ts); public
 * API and MCP callers receive a generic 500, session tools a 502.
 */

import { learningPages, learningPageFilter } from "@/lib/learnings/pages";
import { isUuid } from "@/lib/ids";
import type { LearningStore, NewLearningRow } from "@/lib/learnings/actions";
import type { Learning } from "@/lib/learnings/rules";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

const COLUMNS = "id, org_id, user_id, title, body, status, created_by, suggested_in, created_at, updated_at";

type Row = {
  id: string;
  org_id: string | null;
  user_id: string | null;
  title: string;
  body: string;
  status: "active" | "suggested";
  created_by: string | null;
  suggested_in: string | null;
  created_at: string;
  updated_at: string;
};

function learningOf(row: Row): Learning {
  return {
    id: row.id,
    scope: row.org_id ? "org" : "personal",
    orgId: row.org_id,
    userId: row.user_id,
    title: row.title,
    body: row.body,
    status: row.status,
    createdBy: row.created_by,
    suggestedIn: row.suggested_in,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const learningStore: LearningStore = {
  async list(where, status) {
    const client = createSupabaseAdminClient();
    const rows = await learningPages<Row>(async (cursor, pageSize) => {
      let query = client.from("learnings").select(COLUMNS);
      query = "orgId" in where ? query.eq("org_id", where.orgId) : query.eq("user_id", where.userId);
      if (status) query = query.eq("status", status);
      if (cursor) query = query.or(learningPageFilter(cursor));
      const { data, error } = await query
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(pageSize);
      if (error && probeStatus(error) === "missing") return [];
      if (error) throw error;
      return (data ?? []) as Row[];
    });
    return rows.map(learningOf);
  },

  async count(where, { status, createdBy }) {
    let query = createSupabaseAdminClient().from("learnings").select("id", { count: "exact", head: true });
    query = "orgId" in where ? query.eq("org_id", where.orgId) : query.eq("user_id", where.userId);
    query = query.eq("status", status);
    if (createdBy !== undefined) query = query.eq("created_by", createdBy);
    const { count, error } = await query;
    if (error && probeStatus(error) === "missing") return 0;
    if (error) throw error;
    if (count === null) throw new Error("Couldn't count learnings.");
    return count;
  },

  async get(id) {
    if (!isUuid(id)) return null;
    const { data, error } = await createSupabaseAdminClient().from("learnings").select(COLUMNS).eq("id", id).maybeSingle();
    if (error && probeStatus(error) === "missing") return null;
    if (error) throw error;
    return data ? learningOf(data as Row) : null;
  },

  async insert(row: NewLearningRow) {
    const { data, error } = await createSupabaseAdminClient()
      .from("learnings")
      .insert({
        org_id: row.orgId,
        user_id: row.userId,
        title: row.title,
        body: row.body,
        status: row.status,
        created_by: row.createdBy,
        suggested_in: row.suggestedIn,
      })
      .select(COLUMNS)
      .single();
    if (error) throw error;
    return learningOf(data as Row);
  },

  async update(id, patch) {
    const { data, error } = await createSupabaseAdminClient()
      .from("learnings")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw error;
    return data ? learningOf(data as Row) : null;
  },

  async remove(id) {
    const { data, error } = await createSupabaseAdminClient().from("learnings").delete().eq("id", id).select("id");
    if (error) throw error;
    return (data ?? []).length > 0;
  },
};
