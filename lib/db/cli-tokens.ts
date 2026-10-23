/**
 * The CLI's sign-in (cli_login_codes, cli_tokens): hashes only, service role
 * only — both tables have no policy. lib/auth/cli-login.ts has the flow.
 */

import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type StoredLoginCode = {
  userId: string;
  challenge: string;
  deviceName: string;
  expiresAt: string;
};

/** Keep a code the browser is about to hand the CLI. Expired ones go as it
 *  does, so the table holds only codes still waiting. */
export async function saveLoginCode(codeHash: string, code: StoredLoginCode): Promise<void> {
  const db = createSupabaseAdminClient();
  await db.from("cli_login_codes").delete().lt("expires_at", new Date().toISOString());
  const { error } = await db.from("cli_login_codes").insert({
    code_hash: codeHash,
    user_id: code.userId,
    code_challenge: code.challenge,
    device_name: code.deviceName,
    expires_at: code.expiresAt,
  });
  if (error) throw error;
}

/** The code, removed in the same step, so it can be traded once; null if it
 *  isn't there (never made, or already traded). Expiry is the caller's. */
export async function takeLoginCode(codeHash: string): Promise<StoredLoginCode | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("cli_login_codes")
    .delete()
    .eq("code_hash", codeHash)
    .select("user_id, code_challenge, device_name, expires_at")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    userId: data.user_id,
    challenge: data.code_challenge,
    deviceName: data.device_name,
    expiresAt: data.expires_at,
  };
}

export async function saveCliToken(userId: string, tokenHash: string, deviceName: string): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("cli_tokens")
    .insert({ user_id: userId, token_hash: tokenHash, device_name: deviceName });
  if (error) throw error;
}

/** Whose token this is, or null for none or a revoked one. Marks it used. */
export async function cliTokenUserId(tokenHash: string): Promise<string | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("cli_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .select("user_id")
    .maybeSingle();
  if (error) throw error;
  return data?.user_id ?? null;
}

/** Stop a token working (`outrunner logout`). */
export async function revokeCliToken(tokenHash: string): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("cli_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", tokenHash)
    .is("revoked_at", null);
  if (error) throw error;
}
