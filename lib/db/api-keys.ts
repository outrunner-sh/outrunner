/**
 * API keys and the calls made with them (api_keys, api_requests;
 * supabase/migrations/20261102120000_api_keys.sql): hashes only, service role
 * only. lib/api/keys.ts has what a key is; lib/api/auth.ts signs a request
 * in with one.
 */

import { hashApiKey, keyHint, newApiKey } from "@/lib/api/keys";
import { people } from "@/lib/db/org-members";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** A key as the settings page lists it: never the key itself. */
export type ApiKeyRecord = {
  id: string;
  /** The org an org key is for; null for a personal key. */
  orgId: string | null;
  name: string;
  hint: string;
  /** Who made it, and so who it acts as. */
  userId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** Calls made with it in the last 30 days. */
  recentCalls: number;
};

/** A stored key, as signing in with it reads it. */
export type StoredApiKey = {
  id: string;
  orgId: string | null;
  userId: string;
  expiresAt: string | null;
  revokedAt: string | null;
};

const LISTED = "id, org_id, user_id, name, hint, created_at, expires_at, last_used_at, revoked_at";

type ListedRow = {
  id: string;
  org_id: string | null;
  user_id: string;
  name: string;
  hint: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
};

async function records(rows: ListedRow[]): Promise<ApiKeyRecord[]> {
  if (rows.length === 0) return [];
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  // A revoked key makes no more calls worth counting: only the working
  // ones are counted, in one grouped query (api_key_call_counts).
  const working = rows.filter((r) => !r.revoked_at).map((r) => r.id);
  const [makers, counted] = await Promise.all([
    people(rows.map((r) => r.user_id)),
    working.length
      ? createSupabaseAdminClient().rpc("api_key_call_counts", { key_ids: working, since })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (counted.error) throw counted.error;
  const calls = new Map((counted.data ?? []).map((c: { key_id: string; calls: number }) => [c.key_id, Number(c.calls)]));
  const counts = rows.map((r) => calls.get(r.id) ?? 0);
  return rows.map((r, i) => {
    const maker = makers.get(r.user_id);
    return {
      id: r.id,
      orgId: r.org_id,
      name: r.name,
      hint: r.hint,
      userId: r.user_id,
      createdBy: maker?.name || maker?.login || maker?.email || "Someone",
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
      recentCalls: counts[i],
    };
  });
}

/** An org's keys, newest first, revoked ones last. */
export async function listOrgApiKeys(orgId: string): Promise<ApiKeyRecord[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("api_keys")
    .select(LISTED)
    .eq("org_id", orgId)
    .order("revoked_at", { ascending: false, nullsFirst: true })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return records(data ?? []);
}

/** A user's personal keys, newest first, revoked ones last. */
export async function listPersonalApiKeys(userId: string): Promise<ApiKeyRecord[]> {
  const { data, error } = await createSupabaseAdminClient()
    .from("api_keys")
    .select(LISTED)
    .eq("user_id", userId)
    .is("org_id", null)
    .order("revoked_at", { ascending: false, nullsFirst: true })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return records(data ?? []);
}

/** Make a key; the key itself is in the answer and nowhere else, ever. */
export async function createApiKey(input: {
  userId: string;
  orgId: string | null;
  name: string;
  expiresAt: string | null;
}): Promise<{ key: string; id: string; hint: string }> {
  const key = newApiKey();
  const { data, error } = await createSupabaseAdminClient()
    .from("api_keys")
    .insert({
      user_id: input.userId,
      org_id: input.orgId,
      name: input.name,
      key_hash: hashApiKey(key),
      hint: keyHint(key),
      expires_at: input.expiresAt,
    })
    .select("id")
    .single();
  if (error) throw error;
  return { key, id: data.id, hint: keyHint(key) };
}

/**
 * Stop a key working, by whoever may: an org key by any of its org's admins
 * (`orgId`), a personal key by its maker (`userId`). Its name and hint, or
 * null when there's no such key of theirs still working.
 */
export async function revokeApiKey(
  id: string,
  by: string,
  whose: { orgId: string } | { userId: string },
): Promise<{ name: string; hint: string } | null> {
  let query = createSupabaseAdminClient()
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString(), revoked_by: by })
    .eq("id", id)
    .is("revoked_at", null);
  query = "orgId" in whose ? query.eq("org_id", whose.orgId) : query.eq("user_id", whose.userId).is("org_id", null);
  const { data, error } = await query.select("name, hint");
  if (error) throw error;
  return data?.[0] ?? null;
}

/** The key with this hash, revoked or not, or null. */
export async function findApiKey(keyHash: string): Promise<StoredApiKey | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("api_keys")
    .select("id, org_id, user_id, expires_at, revoked_at")
    .eq("key_hash", keyHash)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { id: data.id, orgId: data.org_id, userId: data.user_id, expiresAt: data.expires_at, revokedAt: data.revoked_at };
}

/** Mark a key used now. */
export async function touchApiKey(id: string): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/** The CLI token with this hash still working: its id and whose it is. */
export async function findCliToken(tokenHash: string): Promise<{ id: string; userId: string } | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("cli_tokens")
    .select("id, user_id")
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw error;
  return data ? { id: data.id, userId: data.user_id } : null;
}

/** Mark a CLI token used now. */
export async function touchCliToken(id: string): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("cli_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/** One call's record: who made it, with what, and how it was answered. */
export async function recordApiRequest(call: {
  keyId: string | null;
  cliTokenId: string | null;
  userId: string;
  orgId: string | null;
  method: string;
  path: string;
  status: number;
}): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("api_requests")
    .insert({
      key_id: call.keyId,
      cli_token_id: call.cliTokenId,
      user_id: call.userId,
      org_id: call.orgId,
      method: call.method.slice(0, 10),
      path: call.path.slice(0, 300),
      status: call.status,
    });
  if (error) throw error;
}

/** How long a call's record is kept: what the settings page and an audit
 *  read is a few weeks; the table would otherwise only grow. */
export const API_REQUEST_DAYS = 90;

/** Forget calls older than API_REQUEST_DAYS (the webhooks tick's). */
export async function pruneApiRequests(now = Date.now()): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("api_requests")
    .delete()
    .lt("created_at", new Date(now - API_REQUEST_DAYS * 24 * 60 * 60 * 1000).toISOString());
  if (error) throw error;
}
