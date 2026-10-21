/**
 * A user's own agent setup for their cloud computers (user_agent_config): an
 * archive of their files in the snapshot bucket, and their MCP servers
 * (sealed) and plugin settings. Service role only — the table has no policy.
 */

import { open, seal } from "@/lib/crypto/secret-box";
import type { Json } from "@/lib/supabase/database.types";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type AgentConfig = {
  archive: { path: string; sha256: string; size: number } | null;
  items: string[];
  /** The MCP servers, opened, as ~/.claude.json has them. */
  mcpServers: Record<string, unknown>;
  settings: Record<string, unknown>;
};

/** The user's setup, or null for none (or before its migration). A sealed
 *  value that no longer opens reads as no MCP servers. */
export async function getAgentConfig(userId: string): Promise<AgentConfig | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("user_agent_config")
    .select("archive_path, archive_sha256, archive_size, items, mcp_ciphertext, settings")
    .eq("user_id", userId)
    .maybeSingle();
  if (error && probeStatus(error) === "missing") return null;
  if (error) throw error;
  if (!data) return null;
  let mcpServers: Record<string, unknown> = {};
  if (data.mcp_ciphertext) {
    try {
      mcpServers = JSON.parse(open(data.mcp_ciphertext)) as Record<string, unknown>;
    } catch (cause) {
      console.error(`User ${userId}'s MCP servers can't be opened`, cause);
    }
  }
  return {
    archive:
      data.archive_path && data.archive_sha256
        ? { path: data.archive_path, sha256: data.archive_sha256, size: data.archive_size ?? 0 }
        : null,
    items: data.items,
    mcpServers,
    settings: (data.settings ?? {}) as Record<string, unknown>,
  };
}

/** Replace the user's setup; returns the archive it replaced, to delete. */
export async function saveAgentConfig(userId: string, config: AgentConfig): Promise<string | null> {
  const previous = await getAgentConfig(userId);
  const names = Object.keys(config.mcpServers).sort();
  const { error } = await createSupabaseAdminClient()
    .from("user_agent_config")
    .upsert(
      {
        user_id: userId,
        archive_path: config.archive?.path ?? null,
        archive_sha256: config.archive?.sha256 ?? null,
        archive_size: config.archive?.size ?? null,
        items: config.items,
        mcp_ciphertext: names.length > 0 ? seal(JSON.stringify(config.mcpServers)) : null,
        mcp_names: names,
        settings: config.settings as Json,
      },
      { onConflict: "user_id" },
    );
  if (error) throw error;
  const old = previous?.archive?.path;
  return old && old !== config.archive?.path ? old : null;
}
