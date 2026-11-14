import { createHash } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { seal } from "@/lib/crypto/secret-box";
import { probeStatus } from "@/lib/supabase/probe";
import type { ClaudeTokenMeta } from "@/lib/runtime/credentials/claude-credentials";

// Uses the existing service-role-only, encrypted, team-only credential store.
export const CLAUDE_SUBSCRIPTION = "claude-subscription";
export const tokenRevision = (ciphertext: string) =>
  createHash("sha256").update(ciphertext).digest("hex");

export async function readClaudeSlot(kind: "personal" | "org", id: string) {
  const db = createSupabaseAdminClient();
  if (kind === "personal") {
    const { data, error } = await db
      .from("user_credentials")
      .select(
        "anthropic_key_ciphertext, anthropic_key_hint, anthropic_key_updated_at",
      )
      .eq("user_id", id)
      .maybeSingle();
    if (error) throw error;
    return data?.anthropic_key_ciphertext
      ? {
          ciphertext: data.anthropic_key_ciphertext,
          hint: data.anthropic_key_hint,
          updatedAt: data.anthropic_key_updated_at,
        }
      : null;
  }
  const { data, error } = await db
    .from("org_provider_keys")
    .select("key_ciphertext, key_hint, updated_at")
    .eq("org_id", id)
    .eq("provider", CLAUDE_SUBSCRIPTION)
    .maybeSingle();
  if (error && probeStatus(error) !== "missing") throw error;
  return data
    ? {
        ciphertext: data.key_ciphertext,
        hint: data.key_hint,
        updatedAt: data.updated_at,
      }
    : null;
}

export async function orgClaudeMeta(org: string): Promise<ClaudeTokenMeta> {
  const row = await readClaudeSlot("org", org);
  return {
    connected: !!row,
    last4: row?.hint?.slice(-4) ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}
export async function saveOrgClaude(org: string, token: string, actor: string) {
  const { error } = await createSupabaseAdminClient()
    .from("org_provider_keys")
    .upsert(
      {
        org_id: org,
        provider: CLAUDE_SUBSCRIPTION,
        key_ciphertext: seal(token),
        key_hint: token.slice(-4),
        updated_by: actor,
      },
      { onConflict: "org_id,provider" },
    );
  if (error) throw error;
}
export async function clearOrgClaude(org: string) {
  const { error } = await createSupabaseAdminClient()
    .from("org_provider_keys")
    .delete()
    .eq("org_id", org)
    .eq("provider", CLAUDE_SUBSCRIPTION);
  if (error) throw error;
}
