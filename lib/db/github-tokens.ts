import { open, seal } from "@/lib/crypto/secret-box";
import type { PersonalTokenInfo, PersonalTokenView } from "@/lib/github/personal-token";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/**
 * A user's own GitHub personal access token (user_github_tokens), sealed at
 * rest. Service role only: `userId` must come from a verified session or a
 * box's signed request.
 */

/** The token as the card shows it, or null with none. */
export async function githubTokenStatus(userId: string): Promise<PersonalTokenView | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("user_github_tokens")
    .select("github_login, token_kind, scopes, expires_at, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  // Asked by personalConnected for every box credential: as githubTokenSecret.
  if (error && tableMissing(error)) return null;
  if (error) throw error;
  return data
    ? { login: data.github_login, kind: data.token_kind, scopes: data.scopes, expiresAt: data.expires_at, updatedAt: data.updated_at }
    : null;
}

/** The table not there yet (migration 20261114140000 unapplied): Postgres's
 *  undefined_table, or PostgREST not finding it in its schema cache. */
function tableMissing(error: { code?: string }): boolean {
  return error.code === "42P01" || error.code === "PGRST205";
}

/** The token itself, or null with none or one that no longer opens (the
 *  encryption key was rotated): the card then shows it to replace. Every
 *  GitHub credential asks here first, so a deploy ahead of its migration
 *  reads as no token rather than breaking GitHub for everyone. */
export async function githubTokenSecret(userId: string): Promise<{ token: string; login: string; updatedAt: string } | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("user_github_tokens")
    .select("token_ciphertext, github_login, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error && tableMissing(error)) {
    console.error("user_github_tokens is missing: apply migration 20261114140000");
    return null;
  }
  if (error) throw error;
  if (!data) return null;
  try {
    return { token: open(data.token_ciphertext), login: data.github_login, updatedAt: data.updated_at };
  } catch {
    console.warn(`GitHub token for user ${userId} no longer opens; treating it as absent`);
    return null;
  }
}

export async function saveGithubToken(userId: string, token: string, info: PersonalTokenInfo): Promise<PersonalTokenView> {
  const row = {
    user_id: userId,
    github_user_id: info.githubUserId,
    github_login: info.login,
    token_kind: info.kind,
    scopes: info.scopes,
    expires_at: info.expiresAt?.toISOString() ?? null,
    token_ciphertext: seal(token),
    updated_at: new Date().toISOString(),
  };
  const { error } = await createSupabaseAdminClient().from("user_github_tokens").upsert(row, { onConflict: "user_id" });
  if (error) throw error;
  return { login: row.github_login, kind: row.token_kind, scopes: row.scopes, expiresAt: row.expires_at, updatedAt: row.updated_at };
}

export async function deleteGithubToken(userId: string): Promise<void> {
  const { error } = await createSupabaseAdminClient().from("user_github_tokens").delete().eq("user_id", userId);
  if (error) throw error;
}
