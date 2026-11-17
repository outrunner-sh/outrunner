/**
 * A session's own variables, MCP servers and subagents
 * (20261117100000_session_overrides.sql; lib/session/session-overrides.ts
 * has the rules), sealed as one. Written once, as the session's row is made;
 * read at every setup of its box. Service role only.
 */

import { open, seal } from "@/lib/crypto/secret-box";
import type { SessionOverrides } from "@/lib/session/session-overrides";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export async function storeSessionOverrides(workspaceId: string, overrides: SessionOverrides): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("session_overrides")
    .upsert({ workspace_id: workspaceId, overrides_ciphertext: seal(JSON.stringify(overrides)) });
  if (error) throw error;
}

/** The session's own, or null for a session given none. */
export async function sessionOverrides(workspaceId: string): Promise<SessionOverrides | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("session_overrides")
    .select("overrides_ciphertext")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const read = JSON.parse(open(data.overrides_ciphertext as string)) as Partial<SessionOverrides>;
  return { env: read.env ?? {}, mcpServers: read.mcpServers ?? {}, subagents: read.subagents ?? {} };
}
