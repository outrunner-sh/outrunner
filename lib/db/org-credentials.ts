/**
 * An org's keys for model providers (20261030115000_org_provider_keys.sql),
 * set by its admins for its members' cloud sessions. A member's own key for a
 * provider always wins (lib/db/credentials.ts reads these after theirs).
 *
 * The server's alone: the admin routes have checked the caller is the org's
 * admin, and the readers that hand a key to a session check the user is
 * still its member.
 */

import { open, seal } from "@/lib/crypto/secret-box";
import { memberRole } from "@/lib/db/orgs";
import { memberOrgCredential } from "@/lib/orgs/credential-access";
import { isKeyProviderId, KEY_PROVIDER_IDS, type KeyProviderId } from "@/lib/providers/registry";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** An org key as Settings shows it: never the key. */
export type OrgKeyStatus = { connected: boolean; hint: string | null; updatedAt: string | null };

const NONE: OrgKeyStatus = { connected: false, hint: null, updatedAt: null };

/** Until the migration is applied, an org has no keys. */
function beforeOrgKeys(error: { code?: string }): boolean {
  return probeStatus(error) === "missing";
}

/** Which providers the org has a key for, and each one's last 4. */
export async function getOrgKeyStatuses(orgId: string): Promise<Record<KeyProviderId, OrgKeyStatus>> {
  const statuses = Object.fromEntries(KEY_PROVIDER_IDS.map((id) => [id, NONE])) as Record<KeyProviderId, OrgKeyStatus>;
  const { data, error } = await createSupabaseAdminClient()
    .from("org_provider_keys")
    .select("provider, key_hint, updated_at")
    .eq("org_id", orgId);
  if (error && beforeOrgKeys(error)) return statuses;
  if (error) throw error;
  for (const row of data) {
    if (isKeyProviderId(row.provider)) {
      statuses[row.provider] = { connected: true, hint: row.key_hint, updatedAt: row.updated_at };
    }
  }
  return statuses;
}

/** Store the org's key for `provider`, as admin `by`. */
export async function setOrgProviderKey(orgId: string, provider: KeyProviderId, apiKey: string, by: string): Promise<void> {
  const key = apiKey.trim();
  if (!key) throw new Error(`${provider} key cannot be empty`);
  const { error } = await createSupabaseAdminClient().from("org_provider_keys").upsert(
    { org_id: orgId, provider, key_ciphertext: seal(key), key_hint: key.slice(-4), updated_by: by },
    { onConflict: "org_id,provider" },
  );
  if (error) throw error;
}

/** Forget the org's key for `provider`. */
export async function clearOrgProviderKey(orgId: string, provider: KeyProviderId): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("org_provider_keys")
    .delete()
    .eq("org_id", orgId)
    .eq("provider", provider);
  if (error) throw error;
}

/**
 * The org's sealed keys a session of `userId`'s may run on, by provider: none
 * when they aren't its member (any more), or `orgId` is undefined. Opened by
 * the caller, as it needs one ({@link openOrgKey}).
 */
export async function sealedOrgKeys(
  userId: string,
  orgId: string | undefined,
  providers?: readonly KeyProviderId[],
): Promise<Map<KeyProviderId, string>> {
  const sealed = new Map<KeyProviderId, string>();
  if (!orgId || (providers && providers.length === 0)) return sealed;
  const rows = await memberOrgCredential(userId, orgId, {
    memberRole,
    async read(id) {
      let query = createSupabaseAdminClient()
        .from("org_provider_keys")
        .select("provider, key_ciphertext")
        .eq("org_id", id);
      if (providers) query = query.in("provider", [...providers]);
      const read = await query;
      if (read.error && beforeOrgKeys(read.error)) return [];
      if (read.error) throw read.error;
      return read.data;
    },
  });
  for (const row of rows ?? []) {
    if (isKeyProviderId(row.provider)) sealed.set(row.provider, row.key_ciphertext);
  }
  return sealed;
}

/** An org key opened, or null when it can't be (the encryption key changed). */
export function openOrgKey(sealedKey: string | undefined, orgId: string, provider: string): string | null {
  if (!sealedKey) return null;
  try {
    return open(sealedKey);
  } catch {
    console.error(`Could not open org ${orgId}'s ${provider} key; treating as unset (rotated CREDENTIALS_ENCRYPTION_KEY?)`);
    return null;
  }
}

/** The org's key for `provider` that a session of `userId`'s may run on. */
export async function orgProviderKey(
  userId: string,
  orgId: string | undefined,
  provider: KeyProviderId,
): Promise<string | null> {
  if (!orgId) return null;
  const sealed = await sealedOrgKeys(userId, orgId, [provider]);
  return openOrgKey(sealed.get(provider), orgId, provider);
}

/** The providers whose org key opens, for `userId`'s model menu. */
export async function usableOrgProviders(userId: string, orgId: string | undefined): Promise<KeyProviderId[]> {
  if (!orgId) return [];
  const sealed = await sealedOrgKeys(userId, orgId);
  return [...sealed].flatMap(([provider, key]) => (openOrgKey(key, orgId, provider) ? [provider] : []));
}
