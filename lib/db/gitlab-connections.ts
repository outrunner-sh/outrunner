import { open, seal } from "@/lib/crypto/secret-box";
import { GitLabError } from "@/lib/gitlab/client";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** Service role only. userId must come from a verified session or signed box. */
export async function gitLabConnection(userId: string) {
  const { data, error } = await createSupabaseAdminClient().from("user_gitlab_connections")
    .select("gitlab_login, updated_at").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data ? { login: data.gitlab_login, updatedAt: data.updated_at } : null;
}

export async function requireGitLabToken(userId: string): Promise<string> {
  const { data, error } = await createSupabaseAdminClient().from("user_gitlab_connections")
    .select("token_ciphertext").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (data) {
    try { return open(data.token_ciphertext); } catch { /* rotated encryption key */ }
  }
  throw new GitLabError("Connect GitLab in Settings → Connections to access this repository.", 409);
}

export async function saveGitLabConnection(userId: string, token: string, user: { id: number; username: string }): Promise<void> {
  const { error } = await createSupabaseAdminClient().from("user_gitlab_connections").upsert({
    user_id: userId, gitlab_user_id: user.id, gitlab_login: user.username,
    token_ciphertext: seal(token), updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (error) throw error;
}

export async function deleteGitLabConnection(userId: string): Promise<void> {
  const { error } = await createSupabaseAdminClient().from("user_gitlab_connections").delete().eq("user_id", userId);
  if (error) throw error;
}
